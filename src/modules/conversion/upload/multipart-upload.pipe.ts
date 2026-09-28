import { PipeTransform } from '@nestjs/common';
import type { ObjectSchema } from 'joi';

import { validateWithSchema } from '@/core/validation/joi-validation';
import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import type {
  CollectedUpload,
  MultipartPart,
  MultipartSource,
  UploadAttempt,
} from './multipart-upload';
import { UploadReader } from './upload-reader';

const FILE_PART = 'file';

/** How long to wait for the parts iterator to explain a cut-short file. */
const CAUSE_LOOKUP_TIMEOUT_MS = 1_000;

/** The non-file parts every conversion route accepts. */
export interface ConversionFields<F extends string> {
  targetFormat: F;
  store?: 'true' | 'false';
}

/**
 * The refusal for a field that fails validation. Each field has its own code
 * so a caller can tell the refusals apart; anything not listed is reported
 * as an unsupported target, the one field every route has.
 */
const FIELD_ERROR_CODES: Record<
  string,
  Exclude<ConversionErrorCode, 'unauthenticated'>
> = {
  store: ConversionErrorCode.INVALID_STORE_FLAG,
  backgroundColor: ConversionErrorCode.INVALID_BACKGROUND_COLOR,
};

/**
 * Reads a conversion upload: exactly one `file` part plus `targetFormat` and an
 * optional `store`, in any order.
 *
 * The document and image routes share everything here — the part whitelist,
 * the drain-before-refuse rule, the translation of transport limits, the field
 * validation and its error codes — and differ only in how the file itself is
 * consumed, which each supplies as {@link receive}.
 *
 * The file part is consumed as it arrives rather than buffered for later:
 * `busboy` will not advance to the next part until the current one is drained,
 * and consuming it under the per-format budget is the only way an oversized
 * upload can be refused without being read to the end (SC-006 / SC-008).
 *
 * The consequence, stated rather than hidden: a request that is both oversized
 * *and* missing `targetFormat` is answered 413, not 400. The field may
 * legitimately arrive after the file, so there is no ordering in which both
 * refusals could take precedence.
 */
export abstract class MultipartUploadPipe<
  R,
  F extends string,
  V extends ConversionFields<F> = ConversionFields<F>,
> implements PipeTransform<MultipartSource, Promise<CollectedUpload<R, F, V>>> {
  /**
   * Validates the non-file parts; the global pipe never sees a multipart
   * body. Its keys are also the whitelist: any other field is refused.
   */
  protected abstract readonly fieldsSchema: ObjectSchema<V>;

  /** The largest configured per-format input limit: the transport ceiling. */
  protected abstract maxInputBytes(): number;

  /** Whether a (validly spelled) target format has a registered handler. */
  protected abstract supportsTarget(format: F): boolean;

  /**
   * Consume the file under the route's byte budget and decide what it is.
   * Record the source format on `attempt` as soon as it is known, so a later
   * refusal (a 413, say) still says what the file was.
   */
  protected abstract receive(
    reader: UploadReader,
    attempt: UploadAttempt<F>,
  ): Promise<R>;

  async transform(request: MultipartSource): Promise<CollectedUpload<R, F, V>> {
    const attempt: UploadAttempt<F> = {
      startedAt: new Date(),
      originalFileName: '',
      sourceFormat: null,
      targetFormat: null,
      inputSizeBytes: 0,
      retentionRequested: false,
    };

    try {
      const { received, fields } = await this.collect(request, attempt);
      return {
        ok: true,
        attempt,
        received,
        targetFormat: fields.targetFormat,
        fields,
      };
    } catch (failure) {
      return { ok: false, attempt, failure };
    }
  }

  private async collect(
    request: MultipartSource,
    attempt: UploadAttempt<F>,
  ): Promise<{ received: R; fields: V }> {
    if (!request.isMultipart()) {
      throw new ConversionException(ConversionErrorCode.MISSING_FILE);
    }

    const fields: Record<string, string> = {};
    let received: R | undefined;

    // Per-call limits: the global registration keeps its own
    // `PHOTO_MAX_SIZE_BYTES` ceiling for the photo route and is not loosened.
    const parts = request.parts({
      limits: { fileSize: this.maxInputBytes(), files: 1 },
    });

    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname !== FILE_PART || received !== undefined) {
            // Drain before refusing: an undrained part stalls the iterator.
            await part.toBuffer().catch(() => undefined);
            throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
          }

          try {
            received = await this.receiveFile(part, attempt);
          } catch (error) {
            throw await this.causeOfCutShortFile(error, parts);
          }
          continue;
        }

        this.collectField(part, fields, attempt);
      }
    } catch (error) {
      throw this.translateTransportError(error);
    }

    const validated = this.validateFields(fields);

    attempt.targetFormat = validated.targetFormat;
    attempt.retentionRequested = validated.store === 'true';

    if (received === undefined) {
      throw new ConversionException(ConversionErrorCode.MISSING_FILE);
    }

    return { received, fields: validated };
  }

  private async receiveFile(
    part: Extract<MultipartPart, { type: 'file' }>,
    attempt: UploadAttempt<F>,
  ): Promise<R> {
    attempt.originalFileName = part.filename ?? '';

    const reader = new UploadReader(part.file, {
      hardLimit: this.maxInputBytes(),
    });

    try {
      return await this.receive(reader, attempt);
    } finally {
      // Read from the reader rather than the result, so a refusal records a
      // size too. For a 413 this is the point at which the budget was
      // exceeded — deliberately not the file's true size, because the rest of
      // it was never read.
      attempt.inputSizeBytes = reader.bytesRead;
    }
  }

  /**
   * When busboy hits a request-level limit — a second file under `files: 1`,
   * typically — it destroys the file part still in flight. Our read of that
   * part then fails as a bare `ERR_STREAM_PREMATURE_CLOSE`, and the *reason*
   * is only reported by the parts iterator, which has it queued. Ask it, so
   * the refusal names the limit instead of surfacing as a 500.
   *
   * Bounded, because a premature close from anywhere else (the client going
   * away) may have nothing queued behind it.
   */
  private async causeOfCutShortFile(
    error: unknown,
    parts: AsyncIterableIterator<MultipartPart>,
  ): Promise<unknown> {
    const code = (error as { code?: string } | undefined)?.code;

    if (code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      return error;
    }

    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CAUSE_LOOKUP_TIMEOUT_MS);
    });

    try {
      await Promise.race([parts.next(), giveUp]);
    } catch (cause) {
      return cause;
    } finally {
      clearTimeout(timer);
    }

    return error;
  }

  private collectField(
    part: Extract<MultipartPart, { type: 'field' }>,
    fields: Record<string, string>,
    attempt: UploadAttempt<F>,
  ): void {
    if (
      !this.fieldNames().includes(part.fieldname) ||
      part.fieldname in fields
    ) {
      throw new ConversionException(ConversionErrorCode.UNEXPECTED_PART);
    }

    fields[part.fieldname] = String(part.value);

    // Recorded as soon as it is seen, not after validation: an attempt that
    // fails later should still show what the caller asked for. A `store`
    // arriving *after* the file part cannot be recovered if the file itself is
    // refused — nothing has been read past it at that point.
    if (part.fieldname === 'store') {
      attempt.retentionRequested = fields.store === 'true';
    }
  }

  private fieldNames(): string[] {
    const keys = this.fieldsSchema.describe().keys as
      | Record<string, unknown>
      | undefined;

    return Object.keys(keys ?? {});
  }

  /** Each field has its own code so a caller can tell the refusals apart. */
  private validateFields(fields: Record<string, string>): V {
    if (fields.targetFormat === undefined) {
      throw new ConversionException(ConversionErrorCode.MISSING_TARGET_FORMAT);
    }

    const result = validateWithSchema(this.fieldsSchema, fields);

    if (!result.ok) {
      throw new ConversionException(
        FIELD_ERROR_CODES[result.failedKeys[0]] ??
          ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    // A format may be spelled correctly and still have no handler registered.
    if (!this.supportsTarget(result.value.targetFormat)) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      );
    }

    return result.value;
  }

  /**
   * `@fastify/multipart` enforces its own limits and raises from the parts
   * iterator once they are passed: `fileSize` (the largest configured
   * per-format limit) and `files: 1`.
   *
   * Both are refusals of an oversized request, so they are reported as the
   * same `input_too_large` our own budget raises, rather than escaping as a
   * bare library error — which would be a 500 `internal_error` to the caller
   * and in their history. A caller must not have to tell two shapes of 413
   * apart depending on which limit happened to fire first.
   */
  private translateTransportError(error: unknown): unknown {
    const code = (error as { code?: string } | undefined)?.code;

    if (
      code === 'FST_REQ_FILE_TOO_LARGE' ||
      code === 'FST_FILES_LIMIT' ||
      code === 'FST_PARTS_LIMIT'
    ) {
      return new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
        limit: this.maxInputBytes(),
      });
    }

    return error;
  }
}
