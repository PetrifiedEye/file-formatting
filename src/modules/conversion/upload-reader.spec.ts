import { Readable } from 'stream';

import { ConversionException } from './conversion.exception';
import { UploadReader } from './upload-reader';

/**
 * A source that reports how much of itself was actually consumed, so
 * "refused without reading the whole file" (SC-006) is an assertion rather
 * than an assumption.
 */
function countingSource(
  totalBytes: number,
  chunkSize = 16,
): { stream: Readable; produced: () => number } {
  let produced = 0;

  const stream = new Readable({
    read() {
      if (produced >= totalBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkSize, totalBytes - produced);
      produced += size;
      this.push(Buffer.alloc(size, 'a'));
    },
  });

  return { stream, produced: () => produced };
}

describe('UploadReader', () => {
  describe('readAll', () => {
    it('returns an upload that is under budget', async () => {
      const { stream } = countingSource(100);
      const reader = new UploadReader(stream, { prefixBytes: 32 });

      await reader.readPrefix();
      const body = await reader.readAll(1000);

      expect(body.length).toBe(100);
      expect(reader.bytesRead).toBe(100);
      expect(reader.complete).toBe(true);
    });

    it('accepts an upload exactly at the budget', async () => {
      const { stream } = countingSource(128);
      const reader = new UploadReader(stream, { prefixBytes: 32 });

      await reader.readPrefix();

      await expect(reader.readAll(128)).resolves.toHaveLength(128);
    });

    it('refuses an upload one byte over the budget', async () => {
      const { stream } = countingSource(129, 1);
      const reader = new UploadReader(stream, { prefixBytes: 32 });

      await reader.readPrefix();

      await expect(reader.readAll(128)).rejects.toBeInstanceOf(
        ConversionException,
      );
    });

    it('destroys the stream instead of consuming the remainder', async () => {
      const { stream, produced } = countingSource(1_000_000, 1024);
      const reader = new UploadReader(stream, { prefixBytes: 4096 });

      await reader.readPrefix();
      await expect(reader.readAll(8192)).rejects.toBeInstanceOf(
        ConversionException,
      );

      // The refusal happens at the budget, not after buffering a megabyte.
      expect(produced()).toBeLessThan(20_000);
      expect(stream.destroyed).toBe(true);
    });

    it('names the applicable limit in the refusal', async () => {
      const { stream } = countingSource(5000, 500);
      const reader = new UploadReader(stream, { prefixBytes: 128 });

      await reader.readPrefix();

      try {
        await reader.readAll(1024);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionException);
        const exception = error as ConversionException;
        expect(exception.code).toBe('input_too_large');
        expect(exception.getStatus()).toBe(413);
        expect(
          (exception.getResponse() as { message: string }).message,
        ).toContain('1024');
      }
    });

    it('refuses immediately when the prefix alone is over budget', async () => {
      // A small configured limit for this format and a larger detection
      // prefix: the budget applies to what was already buffered.
      const { stream } = countingSource(4096, 512);
      const reader = new UploadReader(stream, { prefixBytes: 4096 });

      await reader.readPrefix();

      await expect(reader.readAll(1024)).rejects.toBeInstanceOf(
        ConversionException,
      );
    });
  });

  describe('readPrefix', () => {
    it('stops at the prefix size for a larger upload', async () => {
      const { stream } = countingSource(10_000, 100);
      const reader = new UploadReader(stream, { prefixBytes: 256 });

      const prefix = await reader.readPrefix();

      expect(prefix.length).toBe(256);
      expect(reader.complete).toBe(false);
    });

    it('returns the whole upload when it is smaller than the prefix', async () => {
      const { stream } = countingSource(40, 16);
      const reader = new UploadReader(stream, { prefixBytes: 256 });

      const prefix = await reader.readPrefix();

      expect(prefix.length).toBe(40);
      expect(reader.complete).toBe(true);
      await expect(reader.readAll(1000)).resolves.toHaveLength(40);
    });

    it('returns an empty buffer for a zero-byte upload', async () => {
      const { stream } = countingSource(0);
      const reader = new UploadReader(stream, { prefixBytes: 256 });

      const prefix = await reader.readPrefix();

      expect(prefix.length).toBe(0);
      expect(reader.bytesRead).toBe(0);
      expect(reader.complete).toBe(true);
      await expect(reader.readAll(1000)).resolves.toHaveLength(0);
    });

    it('is idempotent', async () => {
      const { stream } = countingSource(10_000, 100);
      const reader = new UploadReader(stream, { prefixBytes: 256 });

      const first = await reader.readPrefix();
      const second = await reader.readPrefix();

      expect(second.equals(first)).toBe(true);
      expect(reader.bytesRead).toBe(300);
    });
  });

  describe('transport failures', () => {
    it('reports the multipart size limit as the same refusal', async () => {
      const stream = new Readable({
        read() {
          this.destroy(
            Object.assign(new Error('request file too large'), {
              code: 'FST_REQ_FILE_TOO_LARGE',
            }),
          );
        },
      });
      const reader = new UploadReader(stream, { hardLimit: 5_242_880 });

      try {
        await reader.readPrefix();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionException);
        expect((error as ConversionException).code).toBe('input_too_large');
      }
    });

    it('lets an unrelated stream failure through unchanged', async () => {
      const failure = new Error('socket reset');
      const stream = new Readable({
        read() {
          this.destroy(failure);
        },
      });
      const reader = new UploadReader(stream);

      await expect(reader.readPrefix()).rejects.toBe(failure);
    });
  });
});
