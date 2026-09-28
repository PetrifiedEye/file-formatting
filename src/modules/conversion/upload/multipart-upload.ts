import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Readable } from 'stream';

/**
 * The part of a Fastify request the upload pipes need, and nothing more.
 *
 * Declared structurally rather than imported so the pipes can be unit-tested
 * against a hand-rolled iterable, without a server in the way.
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
 * What a conversion request has revealed about itself so far.
 *
 * Filled in progressively, because an attempt can fail before any of it is
 * known — an undetectable file has no source format, and a request naming an
 * unsupported target has no target. The history row records whatever was true
 * at the point of failure.
 */
export interface UploadAttempt<F extends string> {
  /** When reading the request began: the attempt's duration starts here. */
  startedAt: Date;
  originalFileName: string;
  sourceFormat: F | null;
  targetFormat: F | null;
  inputSizeBytes: number;
  retentionRequested: boolean;
}

/**
 * The outcome of reading a conversion upload.
 *
 * A refusal is carried rather than thrown: pipes run before the handler, and
 * the service — not the pipe — owns the attempt's history row and log line.
 * Returning the failure alongside what was learned before it lets the service
 * record every refused request exactly as it records a failed conversion
 * (FR-021, FR-024 / FR-027), and then raise it.
 */
export type CollectedUpload<
  R,
  F extends string,
  V extends { targetFormat: F } = { targetFormat: F; store?: 'true' | 'false' },
> =
  | {
      ok: true;
      attempt: UploadAttempt<F>;
      received: R;
      targetFormat: F;
      /** Every non-file field, validated. */
      fields: V;
    }
  | { ok: false; attempt: UploadAttempt<F>; failure: unknown };

/**
 * Hands the raw request to a conversion upload pipe:
 * `@MultipartUpload(DocumentUploadPipe) upload: CollectedUpload<…>`.
 *
 * The pipe does the reading; this only selects what it reads from. Guards run
 * before pipes, so nothing is read for an unauthenticated caller.
 */
export const MultipartUpload = createParamDecorator(
  (_data: unknown, context: ExecutionContext): unknown =>
    context.switchToHttp().getRequest(),
);
