import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { ConcurrencyLimiter } from '@/core/concurrency/concurrency-limiter';

import { ConversionErrorCode } from './conversion.constants';
import {
  ConversionFormat,
  ConversionRetentionOutcome,
  TransformationType,
} from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionHistoryService } from '@/modules/conversion/history/conversion-history.service';
import { ConversionRetentionService } from '@/modules/conversion/history/conversion-retention.service';
import { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { CONVERSION_LIMITS } from './formats/format-handler';
import type { ConversionLimits } from './formats/format-handler';
import {
  acquireConversionSlot,
  startDeadline,
} from './pipeline/conversion-deadline';
import {
  DOCUMENT_CONVERSION_EXECUTOR,
  InProcessDocumentConversionExecutor,
} from './pipeline/document-conversion.executor';
import type { DocumentConversionExecutor } from './pipeline/document-conversion.executor';
import type {
  CollectedUpload,
  UploadAttempt,
} from '@/modules/conversion/upload/multipart-upload';
import { UploadReader } from '@/modules/conversion/upload/upload-reader';

/** A document upload as read by `DocumentUploadPipe`. */
export type DocumentUpload = CollectedUpload<ReceivedUpload, ConversionFormat>;

/**
 * What the boundary produced: the whole upload, decoded and size-capped.
 *
 * Its format is not decided yet — for every format but XML that takes a full
 * parse, which belongs to the conversion (on a worker thread, under the
 * deadline) rather than to the request body being read.
 */
export interface ReceivedUpload {
  text: string;
  fileName: string;
  sizeBytes: number;
}

export interface ConversionResult {
  buffer: Buffer;
  mediaType: string;
  extension: string;
  sourceFormat: ConversionFormat;
  targetFormat: ConversionFormat;
  inputSizeBytes: number;
  retentionOutcome: ConversionRetentionOutcome;
}

/**
 * The conversion pipeline, in the order the contract fixes.
 *
 * It is split in two because the multipart stream forces it to be. {@link
 * receive} runs while that stream is still open — `DocumentUploadPipe` calls it
 * as the file part arrives, the only moment at which the remainder of an
 * oversized upload can be left unread (SC-006) — and {@link convert} runs once
 * every part has been seen and the fields are validated.
 *
 * The result is serialized **completely into a buffer** before the caller is
 * told anything, which is what makes a partial file unrepresentable (FR-008).
 */
@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

  /**
   * Bounds how many conversions run at once — each on its own worker thread,
   * holding an input and its expanded model — and how many may wait. Past the
   * queue, a request is refused with `service_busy` at once.
   */
  private readonly limiter: ConcurrencyLimiter;
  private readonly executor: DocumentConversionExecutor;

  constructor(
    private readonly registry: FormatRegistryService,
    private readonly detector: FormatDetectorService,
    private readonly history: ConversionHistoryService,
    private readonly retention: ConversionRetentionService,
    @Inject(CONVERSION_LIMITS) private readonly limits: ConversionLimits,
    // Worker threads in the application (see ConversionModule). Constructed
    // by hand — as the unit tests do — the pipeline runs on the calling thread.
    @Optional()
    @Inject(DOCUMENT_CONVERSION_EXECUTOR)
    executor?: DocumentConversionExecutor,
  ) {
    this.limiter = new ConcurrencyLimiter(
      limits.maxConcurrent,
      limits.maxQueue,
    );
    this.executor =
      executor ?? new InProcessDocumentConversionExecutor(registry, detector);
  }

  /**
   * One attempt, start to finish, recorded whatever happens.
   *
   * Reading the multipart body is an HTTP concern and happens first, in
   * `DocumentUploadPipe`; a refusal there arrives here as `upload.failure`
   * together with everything learned before it. Everything around the
   * conversion — the history row, the log line — belongs here, and the clock
   * runs from when the pipe began reading.
   *
   * The record is written from a `finally` and **outside any transaction**, so
   * it survives every failure path: a refused request, a parse error, a rollback
   * further in, and a caller who disconnects before the result reaches them
   * (FR-021, FR-024).
   */
  async execute(
    userId: string,
    upload: DocumentUpload,
  ): Promise<ConversionResult> {
    const state = upload.attempt;
    const startedAt = state.startedAt;

    let result: ConversionResult | undefined;
    let failure: unknown;

    try {
      if (!upload.ok) {
        throw upload.failure;
      }

      result = await this.convert(
        upload.received,
        upload.targetFormat,
        (format) => {
          // Known only once the conversion has detected it — and recorded
          // then, so a refusal after detection still says what the file was.
          state.sourceFormat = format;
        },
      );

      if (state.retentionRequested) {
        // Pessimistic until history-first finalization durably links the file.
        result.retentionOutcome = ConversionRetentionOutcome.FAILED;
      }

      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const durationMs = Date.now() - startedAt.getTime();

      // Written first, and outside any transaction, so that nothing later can
      // erase the record of the attempt (FR-024). It claims `failed` for a
      // file that is on disk but not yet linked: pessimistic until the link
      // exists, and already correct if the link never does.
      let recordId: string | null = null;

      try {
        recordId = await this.history.record({
          userId,
          transformationType: TransformationType.FILE,
          originalFileName: state.originalFileName,
          sourceFormat: state.sourceFormat,
          targetFormat: state.targetFormat,
          inputSizeBytes: state.inputSizeBytes,
          outputSizeBytes: result ? result.buffer.length : null,
          retentionRequested: state.retentionRequested,
          retentionOutcome: state.retentionRequested
            ? ConversionRetentionOutcome.FAILED
            : ConversionRetentionOutcome.NOT_REQUESTED,
          storedFileId: null,
          startedAt,
          durationMs,
          failure,
        });
      } catch (historyError) {
        // The service is itself best-effort; this additionally protects the
        // primary conversion from a broken test double or future regression.
        this.logger.error(
          'Failed to record document conversion history',
          historyError as Error,
        );
      }

      try {
        const finalized = await this.retention.finalize({
          userId,
          conversionRecordId: recordId,
          retentionRequested: state.retentionRequested,
          result: result
            ? {
                userId,
                format: result.targetFormat,
                extension: result.extension,
                buffer: result.buffer,
              }
            : null,
          maxSizeBytes: this.limits.maxOutputBytes,
        });

        if (result) {
          result.retentionOutcome = finalized.retentionOutcome;
        }
      } catch (retentionError) {
        // `finalize` is non-throwing by contract. Preserve the result even if
        // an injected collaborator violates that contract.
        this.logger.error(
          'Failed to finalize document conversion retention',
          retentionError as Error,
        );
      }

      this.log(userId, state, failure, durationMs);
    }
  }

  /**
   * The FR-031 line: who, what direction, how big, how it ended, how long.
   *
   * Deliberately nothing else. The input size is a count and the outcome is a
   * fixed code — no part of the file, and no library message, appears here.
   */
  private log(
    userId: string,
    state: UploadAttempt<ConversionFormat>,
    failure: unknown,
    durationMs: number,
  ): void {
    const outcome =
      failure === undefined
        ? 'success'
        : `failure code=${
            failure instanceof ConversionException
              ? failure.code
              : ConversionErrorCode.INTERNAL_ERROR
          }`;

    const line =
      `conversion user=${userId} ` +
      `source=${state.sourceFormat ?? 'unknown'} ` +
      `target=${state.targetFormat ?? 'unknown'} ` +
      `inputBytes=${state.inputSizeBytes} ` +
      `outcome=${outcome} durationMs=${durationMs}`;

    if (failure === undefined) {
      this.logger.log(line);
    } else {
      this.logger.warn(line);
    }
  }

  /**
   * Steps 4–5: consume the upload under a byte budget and validate its
   * encoding. Called by `DocumentUploadPipe` while the file part's stream is
   * still open.
   *
   * FR-016 sets the limit per source format, and the format is not knowable
   * until some bytes exist: a bounded prefix names the plausible formats, and
   * the most permissive of those bounds the read. The detected format's own
   * limit is applied once detection settles it, in the conversion.
   */
  async receive(
    reader: UploadReader,
    originalFileName: string,
  ): Promise<ReceivedUpload> {
    const prefix = await reader.readPrefix();

    if (prefix.length === 0) {
      throw new ConversionException(ConversionErrorCode.EMPTY_FILE);
    }

    const candidates = this.detector.candidates(
      this.detector.decodePrefix(prefix),
      originalFileName,
    );

    // Nothing recognises it: refuse now rather than reading megabytes first.
    if (candidates.length === 0) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
      );
    }

    // The stream is destroyed the moment this is passed, so an oversized
    // upload is never read to the end.
    const budget = Math.max(
      ...candidates.map((handler) =>
        this.registry.maxInputBytesFor(handler.format),
      ),
    );
    const input = await reader.readAll(budget);

    // Encoding is checked against the whole upload: a truncated prefix could
    // have split a multi-byte character.
    const decoded = this.detector.decode(input);

    return {
      text: decoded.text,
      fileName: originalFileName,
      sizeBytes: input.length,
    };
  }

  /**
   * Steps 6–10 — detect, apply the detected format's limit, parse, guard,
   * serialize — under the time budget and the concurrency bound, on a worker
   * thread.
   *
   * The deadline starts before the queue: waiting behind other conversions
   * must not buy a request extra time.
   */
  async convert(
    received: ReceivedUpload,
    targetFormat: ConversionFormat,
    onSourceFormat?: (format: ConversionFormat) => void,
  ): Promise<ConversionResult> {
    const deadline = startDeadline(this.limits.timeoutMs);

    try {
      const release = await acquireConversionSlot(this.limiter, deadline);

      try {
        const outcome = await this.executor.run(
          {
            text: received.text,
            fileName: received.fileName,
            sizeBytes: received.sizeBytes,
            targetFormat,
            limits: this.limits,
          },
          deadline.signal,
        );

        if (outcome.sourceFormat) {
          onSourceFormat?.(outcome.sourceFormat);
        }

        deadline.check();

        if (!outcome.ok) {
          throw new ConversionException(outcome.code, outcome.params);
        }

        return {
          buffer: Buffer.from(outcome.output),
          mediaType: outcome.mediaType,
          extension: outcome.extension,
          sourceFormat: outcome.sourceFormat,
          targetFormat,
          inputSizeBytes: received.sizeBytes,
          retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
        };
      } finally {
        release();
      }
    } finally {
      deadline.dispose();
    }
  }
}
