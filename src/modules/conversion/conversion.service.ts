import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConversionErrorCode } from './conversion.constants';
import {
  ConversionFormat,
  ConversionRetentionOutcome,
  TransformationType,
} from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionHistoryService } from './conversion-history.service';
import {
  ConversionRetentionService,
  StoredFile,
} from './conversion-retention.service';
import { FormatDetectorService } from './format-detector.service';
import { FormatRegistryService } from './format-registry.service';
import { guardStructure } from './formats/document-node';
import { CONVERSION_LIMITS } from './formats/format-handler';
import type { ConversionLimits } from './formats/format-handler';
import { UploadReader } from './upload-reader';

/**
 * What the request has revealed about itself so far.
 *
 * Filled in progressively, because an attempt can fail before any of it is
 * known — a document whose format is undetectable has no source format, and a
 * request naming an unsupported target has no target. The history row records
 * whatever was true at the point of failure.
 */
export interface AttemptState {
  originalFileName: string;
  sourceFormat: ConversionFormat | null;
  targetFormat: ConversionFormat | null;
  inputSizeBytes: number;
  retentionRequested: boolean;
}

/** What the controller produces once every part has been seen. */
export interface CollectedRequest {
  received: ReceivedUpload;
  targetFormat: ConversionFormat;
}

/** What the boundary produced: a decoded document and the format it is in. */
export interface ReceivedUpload {
  text: string;
  sourceFormat: ConversionFormat;
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
 * receive} runs while that stream is still open — the only moment at which the
 * remainder of an oversized upload can be left unread (SC-006) — and {@link
 * convert} runs once every part has been seen and the fields are validated.
 *
 * The result is serialized **completely into a buffer** before the caller is
 * told anything, which is what makes a partial file unrepresentable (FR-008).
 */
@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

  /**
   * Bounds how many conversions hold a parsed document at once.
   *
   * Honest framing: this bounds **memory, not latency**. Node runs one
   * synchronous parse at a time whatever this is set to, so a long
   * `JSON.parse` delays unrelated requests either way — the lever that
   * actually protects SC-008 is keeping any single parse short, which the
   * per-format byte caps do. What a semaphore prevents is ten concurrent
   * uploads each holding a 5 MiB buffer and its expanded model.
   */
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly registry: FormatRegistryService,
    private readonly detector: FormatDetectorService,
    private readonly history: ConversionHistoryService,
    private readonly retention: ConversionRetentionService,
    @Inject(CONVERSION_LIMITS) private readonly limits: ConversionLimits,
  ) {}

  /**
   * One attempt, start to finish, recorded whatever happens.
   *
   * `collect` is supplied by the controller because reading a multipart body is
   * an HTTP concern; everything around it — the clock, the history row, the log
   * line — belongs here.
   *
   * The record is written from a `finally` and **outside any transaction**, so
   * it survives every failure path: a refused request, a parse error, a rollback
   * further in, and a caller who disconnects before the result reaches them
   * (FR-021, FR-024).
   */
  async execute(
    userId: string,
    collect: (state: AttemptState) => Promise<CollectedRequest>,
  ): Promise<ConversionResult> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const state: AttemptState = {
      originalFileName: '',
      sourceFormat: null,
      targetFormat: null,
      inputSizeBytes: 0,
      retentionRequested: false,
    };

    let result: ConversionResult | undefined;
    let stored: StoredFile | null = null;
    let failure: unknown;

    try {
      const collected = await collect(state);
      result = await this.convert(collected.received, collected.targetFormat);

      // FR-026: nothing is kept for a conversion that did not succeed, so this
      // only ever runs once there is a valid result.
      if (state.retentionRequested) {
        stored = await this.retention.store({
          userId,
          format: result.targetFormat,
          extension: result.extension,
          buffer: result.buffer,
        });

        result.retentionOutcome = stored
          ? ConversionRetentionOutcome.STORED
          : ConversionRetentionOutcome.FAILED;
      }

      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const durationMs = Date.now() - startedMs;

      // Written first, and outside any transaction, so that nothing later can
      // erase the record of the attempt (FR-024). It claims `failed` for a
      // file that is on disk but not yet linked: pessimistic until the link
      // exists, and already correct if the link never does.
      const recordId = await this.history.record({
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

      if (stored && result) {
        result.retentionOutcome = await this.attach(recordId, stored);
      }

      this.log(userId, state, failure, durationMs);
    }
  }

  /**
   * Link a stored file to its conversion record, or drop it.
   *
   * A storage or bookkeeping failure never becomes a conversion failure: the
   * caller still receives a valid file, and both the response header and the
   * history row say `failed` (FR-028).
   */
  private async attach(
    recordId: string | null,
    stored: StoredFile,
  ): Promise<ConversionRetentionOutcome> {
    if (recordId === null) {
      // No record to attach to; the file would be unreachable forever.
      await this.retention.discard(stored);
      return ConversionRetentionOutcome.FAILED;
    }

    try {
      await this.retention.attach(recordId, stored);
      return ConversionRetentionOutcome.STORED;
    } catch {
      await this.retention.discard(stored);
      return ConversionRetentionOutcome.FAILED;
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
    state: AttemptState,
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
   * Steps 4–6: consume the upload under the detected source format's budget and
   * decide what it is.
   *
   * The budget is applied in two stages because FR-016 sets the limit per source
   * format and the format is not knowable until some bytes exist: a bounded
   * prefix names the plausible formats, the most permissive of those bounds the
   * read, and the detected format's own limit is applied once it is known.
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

    const sourceFormat = await this.detector.detect(
      decoded,
      this.limits,
      originalFileName,
    );

    // FR-016: the limit that applies is the *detected* format's, which is why
    // the same byte count can be accepted as XML and refused as CSV.
    const applicable = this.registry.maxInputBytesFor(sourceFormat);

    if (input.length > applicable) {
      throw new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
        limit: applicable,
      });
    }

    return { text: decoded.text, sourceFormat, sizeBytes: input.length };
  }

  /** Steps 7–10, under the time budget. */
  async convert(
    received: ReceivedUpload,
    targetFormat: ConversionFormat,
  ): Promise<ConversionResult> {
    const deadline = this.startDeadline();

    try {
      // Waiters are subject to the same deadline: queueing behind four other
      // conversions must not buy a request extra time.
      await this.acquire(deadline);

      try {
        return await this.runPipeline(received, targetFormat, deadline);
      } finally {
        this.release();
      }
    } finally {
      deadline.dispose();
    }
  }

  private async acquire(deadline: Deadline): Promise<void> {
    if (this.active < this.limits.maxConcurrent) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;

    try {
      deadline.check();
    } catch (error) {
      // The slot was taken the moment the waiter resumed, so it has to be
      // handed on here — otherwise a queue of already-expired requests would
      // consume the pool one slot at a time and never give any back.
      this.release();
      throw error;
    }
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async runPipeline(
    received: ReceivedUpload,
    targetFormat: ConversionFormat,
    deadline: Deadline,
  ): Promise<ConversionResult> {
    // Step 7. A bad request, not a 415: both formats are supported.
    if (received.sourceFormat === targetFormat) {
      throw new ConversionException(ConversionErrorCode.SAME_FORMAT);
    }

    const source = this.registry.requireHandler(
      received.sourceFormat,
      ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
    );
    const target = this.registry.requireHandler(
      targetFormat,
      ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
    );

    const context = { limits: this.limits, signal: deadline.signal };

    // Step 8.
    const model = await source.read(received.text, context);
    deadline.check();

    // Step 9: one shared walk, whatever format produced the model.
    guardStructure(model, this.limits);

    // Step 10: serialize completely, then measure. Nothing has been written to
    // the response at this point, and nothing will be until this succeeds.
    const buffer = await target.write(model, context);
    deadline.check();

    if (buffer.length > this.limits.maxOutputBytes) {
      throw new ConversionException(ConversionErrorCode.OUTPUT_TOO_LARGE, {
        limit: this.limits.maxOutputBytes,
      });
    }

    return {
      buffer,
      mediaType: target.mediaType,
      extension: target.extension,
      sourceFormat: received.sourceFormat,
      targetFormat,
      inputSizeBytes: received.sizeBytes,
      retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
    };
  }

  /**
   * The time budget, taken once the upload is complete (FR-019).
   *
   * Checked at every `await` boundary, and handed to the handlers as an
   * `AbortSignal` so the one incremental parser we have can stop mid-document.
   *
   * Its limit, stated plainly: a single synchronous `JSON.parse` or
   * `yaml.parse` cannot be interrupted once entered. For those the real bound
   * on worst-case time is the per-format byte cap, not this timer — which is
   * why the caps default low. The timer catches everything around them.
   */
  private startDeadline(): Deadline {
    const controller = new AbortController();
    const expiresAt = Date.now() + this.limits.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);

    return {
      signal: controller.signal,
      check: () => {
        if (Date.now() >= expiresAt) {
          throw new ConversionException(ConversionErrorCode.TIMEOUT, {
            limit: this.limits.timeoutMs,
          });
        }
      },
      dispose: () => clearTimeout(timer),
    };
  }
}

interface Deadline {
  signal: AbortSignal;
  check: () => void;
  dispose: () => void;
}
