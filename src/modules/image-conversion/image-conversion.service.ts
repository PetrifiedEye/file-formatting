import { Inject, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Readable } from 'stream';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import {
  ImageFormat,
  ConversionRetentionOutcome,
} from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';
import { ConversionHistoryService } from '@/modules/conversion/conversion-history.service';
import {
  ConversionRetentionService,
  StoredFile,
} from '@/modules/conversion/conversion-retention.service';
import { UploadReader } from '@/modules/conversion/upload-reader';

import { ConvertImageRequestDto } from './dto/convert-image-request.dto';
import { IMAGE_CONVERSION_LIMITS } from './formats/image-format-handler';
import type { ImageConversionLimits } from './formats/image-format-handler';
import { ImageFormatDetectorService } from './image-format-detector.service';
import { ImageFormatRegistryService } from './image-format-registry.service';

/**
 * The part of a Fastify request this service needs, and nothing more.
 *
 * Declared structurally rather than imported so the pipeline can be unit-tested
 * against a hand-rolled iterable — and so the one genuinely HTTP-shaped thing
 * here, reading a multipart body, does not drag the whole framework into every
 * test of the conversion logic.
 */
export interface MultipartSource {
  isMultipart(): boolean;
  parts(options: {
    limits: { fileSize: number; files: number };
  }): AsyncIterableIterator<MultipartPart>;
}

export type MultipartPart =
  | {
      type: 'file';
      fieldname: string;
      filename?: string;
      file: Readable;
      toBuffer(): Promise<Buffer>;
    }
  | { type: 'field'; fieldname: string; value: unknown };

/**
 * What the request has revealed about itself so far.
 *
 * Filled in progressively, because an attempt can fail before any of it is
 * known — an undetectable file has no source format, and a request naming an
 * unsupported target has no target. The history row records whatever was true
 * at the point of failure.
 */
interface AttemptState {
  originalFileName: string;
  sourceFormat: ImageFormat | null;
  targetFormat: ImageFormat | null;
  inputSizeBytes: number;
  retentionRequested: boolean;
}

/** What the boundary produced: the bytes and the format they are in. */
interface ReceivedUpload {
  bytes: Buffer;
  sourceFormat: ImageFormat;
}

export interface ImageConversionResult {
  buffer: Buffer;
  mediaType: string;
  extension: string;
  sourceFormat: ImageFormat;
  targetFormat: ImageFormat;
  inputSizeBytes: number;
  retentionOutcome: ConversionRetentionOutcome;
}

const FILE_PART = 'file';
const FIELD_PARTS = ['targetFormat', 'store'];

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
    request: MultipartSource,
  ): Promise<ImageConversionResult> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const state: AttemptState = {
      originalFileName: '',
      sourceFormat: null,
      targetFormat: null,
      inputSizeBytes: 0,
      retentionRequested: false,
    };

    let result: ImageConversionResult | undefined;
    let stored: StoredFile | null = null;
    let failure: unknown;

    try {
      const collected = await this.collect(request, state);

      result = await this.convert(collected.received, collected.targetFormat);

      // Nothing is kept for a conversion that did not succeed (FR-029), so
      // this only ever runs once there is a valid result.
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

      // Written first, and outside any transaction, so nothing later can erase
      // the record of the attempt. It claims `failed` for a file that is on
      // disk but not yet linked: pessimistic until the link exists, and
      // already correct if the link never does.
      const recordId = await this.history.record({
        userId,
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
   * Read the multipart body, consuming the file under a byte budget.
   *
   * The file part is consumed as it arrives rather than buffered for later:
   * `busboy` will not advance to the next part until the current one is
   * drained, and consuming it under the per-format budget is the only way an
   * oversized upload can be refused without being read to the end (SC-008).
   *
   * The consequence, stated rather than hidden: a request that is both
   * oversized *and* missing `targetFormat` is answered 413, not 400. The field
   * may legitimately arrive after the file, so there is no ordering in which
   * both refusals could take precedence.
   */
  private async collect(
    request: MultipartSource,
    state: AttemptState,
  ): Promise<{ received: ReceivedUpload; targetFormat: ImageFormat }> {
    if (!request.isMultipart()) {
      throw new ConversionException(ConversionErrorCode.MISSING_FILE);
    }

    const fields: Record<string, string> = {};
    let received: ReceivedUpload | undefined;

    // Per-call limits: the global registration in `main.ts` keeps its own
    // `PHOTO_MAX_SIZE_BYTES` ceiling for the photo route and is not loosened.
    const parts = request.parts({
      limits: { fileSize: this.registry.maxConfiguredInputBytes(), files: 1 },
    });

    try {
      await this.readParts(parts, state, fields, (upload) => {
        received = upload;
      });
    } catch (error) {
      throw this.translateMultipartError(error);
    }

    const validated = await this.validateFields(fields);

    state.targetFormat = validated.targetFormat;
    state.retentionRequested = validated.store === 'true';

    if (!received) {
      throw new ConversionException(ConversionErrorCode.MISSING_FILE);
    }

    return { received, targetFormat: validated.targetFormat };
  }

  /**
   * `@fastify/multipart` enforces its own `fileSize` ceiling and aborts the
   * part itself once it is passed.
   *
   * That ceiling is the largest configured per-format limit, so for an upload
   * of the most permissive format it and our own budget coincide and either
   * may fire first. It is the same refusal, so it is reported the same way
   * rather than escaping as a bare library error with no `code` — a caller
   * must not have to tell two shapes of 413 apart depending on which format
   * they happened to send.
   */
  private translateMultipartError(error: unknown): unknown {
    const code = (error as { code?: string } | undefined)?.code;

    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
      return new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
        limit: this.registry.maxConfiguredInputBytes(),
      });
    }

    return error;
  }

  private async readParts(
    parts: AsyncIterableIterator<MultipartPart>,
    state: AttemptState,
    fields: Record<string, string>,
    onFile: (received: ReceivedUpload) => void,
  ): Promise<void> {
    let seenFile = false;

    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== FILE_PART || seenFile) {
          // Drain before refusing: an undrained part stalls the iterator.
          await part.toBuffer().catch(() => undefined);
          throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
        }

        state.originalFileName = part.filename ?? '';

        const reader = new UploadReader(part.file, {
          hardLimit: this.registry.maxConfiguredInputBytes(),
        });

        try {
          const upload = await this.receive(
            reader,
            state.originalFileName,
            (format) => {
              // Recorded the moment detection settles, not when the read
              // completes: a 413 is raised in between, and the row should say
              // what the file was rather than leaving the format unknown.
              state.sourceFormat = format;
            },
          );

          seenFile = true;
          onFile(upload);
        } finally {
          // Read from the reader rather than the result, so a refusal records
          // a size too. For a 413 this is where the budget was exceeded —
          // deliberately not the file's true size, because the rest of it was
          // never read (SC-008).
          state.inputSizeBytes = reader.bytesRead;
        }
        continue;
      }

      if (!FIELD_PARTS.includes(part.fieldname) || part.fieldname in fields) {
        throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
      }

      fields[part.fieldname] = String(part.value);

      // Recorded as soon as it is seen, not after validation: an attempt that
      // fails later should still show what the caller asked for.
      if (part.fieldname === 'store') {
        state.retentionRequested = fields.store === 'true';
      }
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
   */
  private async receive(
    reader: UploadReader,
    originalFileName: string,
    onDetected: (format: ImageFormat) => void,
  ): Promise<ReceivedUpload> {
    const prefix = await reader.readPrefix();

    if (prefix.length === 0) {
      throw new ConversionException(ConversionErrorCode.EMPTY_FILE);
    }

    // Nothing recognises it: refuse now rather than reading megabytes first.
    const sourceFormat = this.detector.require(prefix, originalFileName);

    onDetected(sourceFormat);

    return {
      bytes: await reader.readAll(this.registry.maxInputBytesFor(sourceFormat)),
      sourceFormat,
    };
  }

  /**
   * Validate the non-file parts explicitly.
   *
   * The global `ValidationPipe` never sees a multipart body, so the DTO is
   * applied by hand here rather than being quietly skipped. Each field has its
   * own code so a caller can tell the refusals apart.
   */
  private async validateFields(
    fields: Record<string, string>,
  ): Promise<ConvertImageRequestDto> {
    if (fields.targetFormat === undefined) {
      throw new ConversionException(ConversionErrorCode.MISSING_TARGET_FORMAT);
    }

    const dto = plainToInstance(ConvertImageRequestDto, fields);
    const failures = await validate(dto, { whitelist: true });

    for (const failure of failures) {
      throw new ConversionException(
        failure.property === 'store'
          ? ConversionErrorCode.INVALID_STORE_FLAG
          : ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    // A format may be spelled correctly and still have no handler registered.
    if (!this.registry.handlerFor(dto.targetFormat)) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    return dto;
  }

  /** The conversion itself, under the time budget and the concurrency bound. */
  private async convert(
    received: ReceivedUpload,
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
    received: ReceivedUpload,
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
   * Link a stored file to its conversion record, or drop it.
   *
   * A storage or bookkeeping failure never becomes a conversion failure: the
   * caller still receives a valid image, and both the response header and the
   * history row say `failed` (FR-031).
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
   * The FR-032 line: who, what direction, how big, how it ended, how long.
   *
   * Deliberately nothing else. The input size is a count and the outcome is a
   * fixed code — no file name, no pixels, and no library message appears here.
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
