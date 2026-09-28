import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import {
  ImageFormat,
  ConversionRetentionOutcome,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';
import { ConversionHistoryService } from '@/modules/conversion/history/conversion-history.service';
import { ConversionRetentionService } from '@/modules/conversion/history/conversion-retention.service';
import type {
  CollectedUpload,
  UploadAttempt,
} from '@/modules/conversion/upload/multipart-upload';
import { UploadReader } from '@/modules/conversion/upload/upload-reader';

import { IMAGE_CONVERSION_LIMITS } from './formats/image-format-handler';
import type { ImageConversionLimits } from './formats/image-format-handler';
import { ImageFormatDetectorService } from '@/modules/image-conversion/detection/image-format-detector.service';
import { ImageFormatRegistryService } from '@/modules/image-conversion/detection/image-format-registry.service';

/** What the boundary produced: the bytes and the format they are in. */
export interface ReceivedImage {
  bytes: Buffer;
  sourceFormat: ImageFormat;
}

/** An image upload as read by `ImageUploadPipe`. */
export type ImageUpload = CollectedUpload<ReceivedImage, ImageFormat>;

export interface ImageConversionResult {
  buffer: Buffer;
  mediaType: string;
  extension: string;
  sourceFormat: ImageFormat;
  targetFormat: ImageFormat;
  inputSizeBytes: number;
  retentionOutcome: ConversionRetentionOutcome;
}

/**
 * The image conversion pipeline, in the order the contract fixes.
 *
 * Two properties are worth naming, because the shape of this file exists to
 * hold them:
 *
 * - **The result is encoded completely into a buffer before any header is
 *   written.** A partially written image is not a case to be handled; it is
 *   unrepresentable (FR-012).
 * - **Every authenticated attempt is recorded**, from a `finally` block and
 *   outside any transaction, so the row survives a refusal, a render failure,
 *   a timeout, a rollback, and a caller who disconnects (FR-027, SC-011).
 */
@Injectable()
export class ImageConversionService {
  private readonly logger = new Logger(ImageConversionService.name);

  /**
   * Bounds how many conversions hold a decoded raster at once.
   *
   * A **separate** counter from the text pipeline's, deliberately: sharing one
   * would let a burst of document conversions starve image conversions of
   * slots, and the two have unrelated memory profiles. Peak raster memory here
   * is `maxPixels × 4 bytes × maxConcurrent`.
   */
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly registry: ImageFormatRegistryService,
    private readonly detector: ImageFormatDetectorService,
    private readonly history: ConversionHistoryService,
    private readonly retention: ConversionRetentionService,
    @Inject(IMAGE_CONVERSION_LIMITS)
    private readonly limits: ImageConversionLimits,
  ) {}

  /** For the discovery route, so the controller reads one source of truth. */
  describeFormats() {
    return this.registry.describe();
  }

  /**
   * One attempt, start to finish, recorded whatever happens.
   *
   * The record is written from a `finally` and **outside any transaction**.
   * That is what makes FR-027 true for the disconnect case in particular: the
   * caller going away rejects the send, not the conversion, and the row is
   * already on its way by then.
   */
  async execute(
    userId: string,
    upload: ImageUpload,
  ): Promise<ImageConversionResult> {
    const state = upload.attempt;
    const startedAt = state.startedAt;

    let result: ImageConversionResult | undefined;
    let failure: unknown;

    try {
      // A refusal while reading the body (`ImageUploadPipe`) is recorded here
      // exactly like a failed conversion, then raised.
      if (!upload.ok) {
        throw upload.failure;
      }

      result = await this.convert(upload.received, upload.targetFormat);

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

      // Written first, and outside any transaction, so nothing later can erase
      // the record of the attempt. It claims `failed` for a file that is on
      // disk but not yet linked: pessimistic until the link exists, and
      // already correct if the link never does.
      let recordId: string | null = null;

      try {
        recordId = await this.history.record({
          userId,
          transformationType: TransformationType.IMAGE,
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
        this.logger.error(
          'Failed to record image conversion history',
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
        this.logger.error(
          'Failed to finalize image conversion retention',
          retentionError as Error,
        );
      }

      this.log(userId, state, failure, durationMs);
    }
  }

  /**
   * Decide what the upload is, then consume it under *that* format's budget.
   *
   * Detection happens on the bounded prefix and before a single further byte
   * is read, which is possible here and is not in the text pipeline: an image
   * is identified by its magic bytes, while a text format has to prove itself
   * by parsing. Two consequences follow, and both are improvements over
   * reading first and measuring after:
   *
   * - the budget applied is exactly the detected format's from the very first
   *   byte, so a 2 MiB SVG cap is never briefly relaxed to PNG's 10 MiB;
   * - a 413 still knows what the file *was*, so the history row records the
   *   source format rather than leaving it null.
   *
   * The reader destroys the stream the moment the budget is passed, so an
   * oversized upload is refused without being read to the end (SC-008). This
   * is what makes the same byte count acceptable as PNG and refused as SVG.
   *
   * Called by `ImageUploadPipe` while the file part's stream is still open.
   */
  async receive(
    reader: UploadReader,
    attempt: UploadAttempt<ImageFormat>,
  ): Promise<ReceivedImage> {
    const prefix = await reader.readPrefix();

    if (prefix.length === 0) {
      throw new ConversionException(ConversionErrorCode.EMPTY_FILE);
    }

    // Nothing recognises it: refuse now rather than reading megabytes first.
    const sourceFormat = this.detector.require(
      prefix,
      attempt.originalFileName,
    );

    // Recorded the moment detection settles, not when the read completes: a
    // 413 is raised in between, and the row should say what the file was
    // rather than leaving the format unknown.
    attempt.sourceFormat = sourceFormat;

    return {
      bytes: await reader.readAll(this.registry.maxInputBytesFor(sourceFormat)),
      sourceFormat,
    };
  }

  /** The conversion itself, under the time budget and the concurrency bound. */
  private async convert(
    received: ReceivedImage,
    targetFormat: ImageFormat,
  ): Promise<ImageConversionResult> {
    const deadline = this.startDeadline();

    try {
      // Waiters are subject to the same deadline: queueing behind other
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
    received: ReceivedImage,
    targetFormat: ImageFormat,
    deadline: Deadline,
  ): Promise<ImageConversionResult> {
    // A bad request, not a 415: both formats are supported and both directions
    // exist in principle — it is the *request* that is wrong.
    if (received.sourceFormat === targetFormat) {
      throw new ConversionException(ConversionErrorCode.SAME_FORMAT);
    }

    // Resolved from the capability set, never from a literal list. A raster
    // source naming `svg` lands on `image_vectorisation_unsupported` here
    // because the SVG handler has no `encode` — FR-003 is structural.
    const source = this.registry.requireDecoder(received.sourceFormat);
    const target = this.registry.requireEncoder(targetFormat);

    const context = { limits: this.limits, signal: deadline.signal };

    const image = await this.underDeadline(
      () => source.decode(received.bytes, context),
      deadline,
    );
    deadline.check();

    // Serialize completely, then measure. Nothing has been written to the
    // response at this point, and nothing will be until this succeeds.
    const buffer = await this.underDeadline(
      () => target.encode(image, context),
      deadline,
    );
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
      inputSizeBytes: received.bytes.length,
      retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
    };
  }

  /**
   * Run one stage, reporting an expired deadline as the shared `timeout` code.
   *
   * A handler that honours the `AbortSignal` rejects with an `AbortError`,
   * which is a library failure shape, not one of ours. Left alone it would
   * surface as a 500 `internal_error` — the wrong answer for a conversion that
   * simply ran out of time, and the wrong `error_category` in history.
   */
  private async underDeadline<T>(
    run: () => Promise<T>,
    deadline: Deadline,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ConversionException) {
        throw error;
      }

      // `check` throws the timeout if the budget is genuinely spent; if it is
      // not, the failure was something else and is re-raised unchanged.
      if (deadline.signal.aborted) {
        throw new ConversionException(ConversionErrorCode.TIMEOUT, {
          limit: this.limits.timeoutMs,
        });
      }

      throw error;
    }
  }

  /**
   * The FR-032 line: who, what direction, how big, how it ended, how long.
   *
   * Deliberately nothing else. The input size is a count and the outcome is a
   * fixed code — no file name, no pixels, and no library message appears here.
   */
  private log(
    userId: string,
    state: UploadAttempt<ImageFormat>,
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
      `image conversion user=${userId} ` +
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
   * The time budget, taken once the upload is complete (FR-022).
   *
   * Genuinely enforceable here, unlike the text pipeline's: sharp's work runs
   * on the libuv threadpool rather than the event loop, so the deadline is
   * checked between decode and encode and unrelated requests keep being
   * served. The one caveat is a synchronous SVG render, where the
   * output-dimension cap is the operative bound.
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
