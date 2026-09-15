import { Readable } from 'stream';

import {
  ConversionErrorCode,
  DETECTION_PREFIX_BYTES,
} from './conversion.constants';
import { ConversionException } from './conversion.exception';

export interface UploadReaderOptions {
  /** How much to buffer before the source format is decided. */
  prefixBytes?: number;
  /**
   * The multipart ceiling this part was accepted under — the largest configured
   * per-format limit. Used only to name a limit if the transport aborts the
   * stream before our own budget applies.
   */
  hardLimit?: number;
}

/**
 * Consumes an upload under a byte budget that is only knowable once the source
 * format is.
 *
 * The two stages exist because FR-016 sets the limit **per source format** and
 * detection needs bytes to work with: {@link readPrefix} buffers a bounded
 * 64 KiB, the caller detects the format from it, and {@link readAll} then
 * consumes the rest under that format's budget. The moment the budget is
 * exceeded the stream is destroyed — so an oversized upload is refused without
 * ever being read to the end (SC-006), rather than buffered and then measured.
 */
export class UploadReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly prefixBytes: number;
  private readonly hardLimit?: number;
  private readonly chunks: Buffer[] = [];

  private bytes = 0;
  private budget?: number;
  private ended = false;

  constructor(
    private readonly stream: Readable,
    options: UploadReaderOptions = {},
  ) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    this.prefixBytes = options.prefixBytes ?? DETECTION_PREFIX_BYTES;
    this.hardLimit = options.hardLimit;
  }

  /** Bytes consumed so far. For a refusal this is where the budget was hit. */
  get bytesRead(): number {
    return this.bytes;
  }

  /** Whether the upload was exhausted — true when it fit inside the prefix. */
  get complete(): boolean {
    return this.ended;
  }

  /**
   * Buffer up to `prefixBytes`, or the whole upload if it is smaller. Safe to
   * call more than once; later calls return the same prefix.
   */
  async readPrefix(): Promise<Buffer> {
    while (!this.ended && this.bytes < this.prefixBytes) {
      await this.pull();
    }

    return this.buffered().subarray(0, this.prefixBytes);
  }

  /**
   * Consume the remainder under `budget` and return the whole upload.
   *
   * Throws `input_too_large` the moment the budget is exceeded — including
   * immediately, when the prefix alone already went past it.
   */
  async readAll(budget: number): Promise<Buffer> {
    this.budget = budget;
    this.enforce();

    while (!this.ended) {
      await this.pull();
      this.enforce();
    }

    return this.buffered();
  }

  private buffered(): Buffer {
    return Buffer.concat(this.chunks, this.bytes);
  }

  private async pull(): Promise<void> {
    let result: IteratorResult<Buffer>;

    try {
      result = await this.iterator.next();
    } catch (error) {
      throw this.translate(error);
    }

    if (result.done) {
      this.ended = true;
      return;
    }

    this.chunks.push(result.value);
    this.bytes += result.value.length;
  }

  private enforce(): void {
    if (this.budget === undefined || this.bytes <= this.budget) {
      return;
    }

    this.stream.destroy();
    throw new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
      limit: this.budget,
    });
  }

  /**
   * `@fastify/multipart` aborts the part itself once its own `fileSize` ceiling
   * is passed. That is the same refusal ours is, so it is reported the same way
   * rather than surfacing as a 500.
   */
  private translate(error: unknown): unknown {
    const code = (error as { code?: string } | undefined)?.code;
    const isTooLarge =
      code === 'FST_REQ_FILE_TOO_LARGE' ||
      code === 'FST_PARTS_LIMIT' ||
      (this.stream as Readable & { truncated?: boolean }).truncated === true;

    if (!isTooLarge) {
      return error;
    }

    return new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
      limit: this.budget ?? this.hardLimit ?? this.bytes,
    });
  }
}
