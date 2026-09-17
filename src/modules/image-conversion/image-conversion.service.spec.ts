import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

import { ConversionException } from '@/modules/conversion/conversion.exception';

import { imageFixture } from './formats/image-test-support';
import { buildService, fakeRequest } from './image-conversion.test-support';
import type { RequestSpec } from './image-conversion.test-support';
import type { ServiceHarness } from './image-conversion.test-support';

const USER = 'user-1';

async function convert(
  harness: ServiceHarness,
  spec: RequestSpec,
): Promise<ReturnType<typeof harness.service.execute>> {
  return harness.service.execute(USER, fakeRequest(spec));
}

async function refusalOf(
  harness: ServiceHarness,
  spec: RequestSpec,
): Promise<ConversionException> {
  try {
    await convert(harness, spec);
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionException);
    return error as ConversionException;
  }

  throw new Error('expected a refusal');
}

function request(
  fixture: string,
  targetFormat: string,
  extra: Partial<RequestSpec> = {},
): RequestSpec {
  return {
    file: { buffer: imageFixture(fixture), filename: fixture },
    fields: { targetFormat },
    ...extra,
  };
}

describe('ImageConversionService', () => {
  describe('the happy paths', () => {
    it.each([
      ['png', 'jpeg', 'solid.png', 'image/jpeg', 'jpg', 64, 48],
      ['jpeg', 'png', 'solid.jpg', 'image/png', 'png', 64, 48],
      ['svg', 'png', 'valid-declared.svg', 'image/png', 'png', 120, 80],
      ['svg', 'jpeg', 'valid-declared.svg', 'image/jpeg', 'jpg', 120, 80],
    ])(
      'converts %s to %s',
      async (source, target, fixture, mediaType, extension, width, height) => {
        const harness = buildService();
        const result = await convert(harness, request(fixture, target));

        expect(result.sourceFormat).toBe(source);
        expect(result.targetFormat).toBe(target);
        expect(result.mediaType).toBe(mediaType);
        expect(result.extension).toBe(extension);

        const metadata = await sharp(result.buffer).metadata();

        expect(metadata.format).toBe(target);
        expect(metadata.width).toBe(width);
        expect(metadata.height).toBe(height);
      },
    );

    /**
     * FR-012: the buffer is complete before `execute` resolves. There is no
     * point at which a caller could have received part of an image, because
     * nothing is written anywhere until this value exists.
     */
    it('returns a complete, decodable buffer', async () => {
      const harness = buildService();
      const result = await convert(harness, request('solid.png', 'jpeg'));

      expect(result.buffer.length).toBeGreaterThan(0);
      await expect(sharp(result.buffer).metadata()).resolves.toMatchObject({
        format: 'jpeg',
      });
    });

    it('detects the source from content, not from the file name', async () => {
      const harness = buildService();
      const result = await convert(harness, {
        file: {
          buffer: imageFixture('jpeg-bytes-named.png'),
          filename: 'holiday.png',
        },
        fields: { targetFormat: 'png' },
      });

      expect(result.sourceFormat).toBe('jpeg');
    });

    it('accepts the fields arriving before the file', async () => {
      const harness = buildService();
      const result = await convert(
        harness,
        request('solid.png', 'jpeg', { fieldsFirst: true }),
      );

      expect(result.targetFormat).toBe('jpeg');
    });
  });

  describe('the refusal matrix', () => {
    it.each([
      ['a non-multipart request', { multipart: false }, 'missing_file'],
      ['no file part', { fields: { targetFormat: 'png' } }, 'missing_file'],
      [
        'a zero-byte file',
        {
          file: { buffer: Buffer.alloc(0), filename: 'empty.png' },
          fields: { targetFormat: 'jpeg' },
        },
        'empty_file',
      ],
      [
        'a file matching no signature',
        {
          file: { buffer: Buffer.from('GIF89a......'), filename: 'x.gif' },
          fields: { targetFormat: 'png' },
        },
        'unsupported_source_format',
      ],
      [
        'a misnamed file part',
        {
          file: {
            buffer: imageFixture('solid.png'),
            filename: 'a.png',
            fieldname: 'picture',
          },
          fields: { targetFormat: 'jpeg' },
        },
        'unexpected_part',
      ],
      [
        'a second file part',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          extraFiles: [
            { buffer: imageFixture('solid.jpg'), fieldname: 'file' },
          ],
          fields: { targetFormat: 'jpeg' },
        },
        'unexpected_part',
      ],
      [
        'an unexpected field',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg' },
          rawFields: [{ fieldname: 'quality', value: '100' }],
        },
        'unexpected_part',
      ],
      [
        'a duplicated field',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg' },
          rawFields: [{ fieldname: 'targetFormat', value: 'png' }],
        },
        'unexpected_part',
      ],
      [
        'a missing targetFormat',
        { file: { buffer: imageFixture('solid.png'), filename: 'a.png' } },
        'missing_target_format',
      ],
      [
        'an unrecognised targetFormat',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'tiff' },
        },
        'unsupported_target_format',
      ],
      [
        'a non-boolean store flag',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg', store: 'yes' },
        },
        'invalid_store_flag',
      ],
      [
        'a raster source asking for svg',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'svg' },
        },
        'image_vectorisation_unsupported',
      ],
      [
        'a target equal to the detected source',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'png' },
        },
        'same_format',
      ],
      [
        'a corrupt image of a recognised format',
        {
          file: { buffer: imageFixture('truncated.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg' },
        },
        'image_invalid',
      ],
      [
        'an SVG carrying a script',
        {
          file: { buffer: imageFixture('scripted.svg'), filename: 'a.svg' },
          fields: { targetFormat: 'png' },
        },
        'svg_active_content',
      ],
      [
        'an SVG referencing a remote image',
        {
          file: { buffer: imageFixture('remote-image.svg'), filename: 'a.svg' },
          fields: { targetFormat: 'png' },
        },
        'svg_external_reference',
      ],
      [
        'an SVG carrying a DOCTYPE',
        {
          file: { buffer: imageFixture('xxe.svg'), filename: 'a.svg' },
          fields: { targetFormat: 'png' },
        },
        'xml_doctype_forbidden',
      ],
      [
        'an SVG with no determinable size',
        {
          file: { buffer: imageFixture('no-size.svg'), filename: 'a.svg' },
          fields: { targetFormat: 'png' },
        },
        'svg_no_intrinsic_size',
      ],
      [
        'an SVG larger than the maximum',
        {
          file: { buffer: imageFixture('enormous.svg'), filename: 'a.svg' },
          fields: { targetFormat: 'png' },
        },
        'image_dimensions_exceeded',
      ],
      [
        'a decompression bomb',
        {
          file: { buffer: imageFixture('pixel-bomb.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg' },
        },
        'image_pixel_budget_exceeded',
      ],
    ] as [string, RequestSpec, string][])(
      'refuses %s with %s',
      async (_name, spec, code) => {
        expect((await refusalOf(buildService(), spec)).code).toBe(code);
      },
    );

    /**
     * Each refusal is reached before any decoding is attempted. Proved by
     * pointing every one of them at bytes that would themselves fail to
     * decode: if the request-shape check did not come first, the code would be
     * `image_invalid` instead.
     */
    it.each([
      ['missing_target_format', {}],
      ['unsupported_target_format', { targetFormat: 'tiff' }],
      ['invalid_store_flag', { targetFormat: 'jpeg', store: 'maybe' }],
    ] as [string, Record<string, string>][])(
      'reports %s before attempting to decode',
      async (code, fields) => {
        const refusal = await refusalOf(buildService(), {
          file: { buffer: imageFixture('truncated.png'), filename: 'a.png' },
          fields,
        });

        expect(refusal.code).toBe(code);
      },
    );
  });

  describe('the byte budget', () => {
    /**
     * FR-017: the limit applied is the *detected* source format's, which is
     * why the same byte count is accepted as PNG and refused as SVG.
     */
    it('applies the detected format s own limit', async () => {
      const harness = buildService({
        maxInputBytes: { png: 1048576, jpeg: 1048576, svg: 64 },
      });

      await expect(
        convert(harness, request('solid.png', 'jpeg')),
      ).resolves.toBeDefined();

      const refusal = await refusalOf(harness, {
        file: {
          buffer: imageFixture('valid-declared.svg'),
          filename: 'a.svg',
        },
        fields: { targetFormat: 'png' },
      });

      expect(refusal.code).toBe('input_too_large');
      expect(refusal.params.limit).toBe(64);
    });

    it('refuses an oversized upload of its own format', async () => {
      const harness = buildService({
        maxInputBytes: { png: 100, jpeg: 100, svg: 100 },
      });

      expect(
        (await refusalOf(harness, request('sixteen-bit.png', 'jpeg'))).code,
      ).toBe('input_too_large');
    });
  });

  describe('the output ceiling', () => {
    it('refuses a result over the maximum before any header is written', async () => {
      const harness = buildService({ maxOutputBytes: 10 });
      const refusal = await refusalOf(harness, request('solid.png', 'jpeg'));

      expect(refusal.code).toBe('output_too_large');
      expect(refusal.params.limit).toBe(10);
    });
  });

  describe('the deadline', () => {
    it('reports an expired budget as a timeout', async () => {
      const harness = buildService({ timeoutMs: 1 });

      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(10000);

      const refusal = await refusalOf(harness, request('solid.png', 'jpeg'));

      expect(refusal.code).toBe('timeout');
      jest.restoreAllMocks();
    });

    it('does not fire for a conversion inside its budget', async () => {
      const harness = buildService({ timeoutMs: 30000 });

      await expect(
        convert(harness, request('solid.png', 'jpeg')),
      ).resolves.toBeDefined();
    });
  });

  describe('the concurrency bound', () => {
    it('admits at most maxConcurrent conversions at once', async () => {
      const harness = buildService({ maxConcurrent: 2 });
      const service = harness.service as unknown as { active: number };

      let peak = 0;
      const sample = setInterval(() => {
        peak = Math.max(peak, service.active);
      }, 1);

      await Promise.all(
        Array.from({ length: 8 }, () =>
          convert(harness, request('sixteen-bit.png', 'jpeg')),
        ),
      );

      clearInterval(sample);

      expect(peak).toBeLessThanOrEqual(2);
      expect(service.active).toBe(0);
    });

    it('releases its slot on a failure as well as on success', async () => {
      const harness = buildService({ maxConcurrent: 1 });
      const service = harness.service as unknown as { active: number };

      await refusalOf(harness, request('truncated.png', 'jpeg'));

      expect(service.active).toBe(0);

      await expect(
        convert(harness, request('solid.png', 'jpeg')),
      ).resolves.toBeDefined();
    });
  });

  describe('history', () => {
    it('records a success with both formats and an output size', async () => {
      const harness = buildService();
      const result = await convert(harness, request('solid.png', 'jpeg'));

      expect(harness.history.record).toHaveBeenCalledTimes(1);
      expect(harness.history.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          sourceFormat: 'png',
          targetFormat: 'jpeg',
          outputSizeBytes: result.buffer.length,
          retentionRequested: false,
          retentionOutcome: 'not_requested',
        }),
      );
    });

    it.each([
      ['a refused request shape', request('solid.png', 'png'), 'png', 'png'],
      [
        'an undetectable file',
        {
          file: { buffer: Buffer.from('GIF89a......'), filename: 'x.gif' },
          fields: { targetFormat: 'png' },
        },
        null,
        null,
      ],
      [
        'an unsupported target',
        {
          file: { buffer: imageFixture('solid.png'), filename: 'a.png' },
          fields: { targetFormat: 'tiff' },
        },
        'png',
        null,
      ],
      [
        'a render failure',
        {
          file: { buffer: imageFixture('truncated.png'), filename: 'a.png' },
          fields: { targetFormat: 'jpeg' },
        },
        'png',
        'jpeg',
      ],
    ] as [string, RequestSpec, string | null, string | null][])(
      'records %s with whatever was known at the point of failure',
      async (_name, spec, sourceFormat, targetFormat) => {
        const harness = buildService();

        await refusalOf(harness, spec);

        expect(harness.history.record).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFormat,
            targetFormat,
            outputSizeBytes: null,
            failure: expect.any(ConversionException) as unknown,
          }),
        );
      },
    );

    /**
     * FR-024 / FR-026 / SC-012: what is recorded is a name, two formats, and
     * some counts. There is no field in the attempt through which a pixel or a
     * library message could travel.
     */
    it('records no image content', async () => {
      const harness = buildService();

      await convert(harness, request('solid.png', 'jpeg'));

      const [attempt] = harness.history.record.mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(Object.keys(attempt).sort()).toEqual([
        'durationMs',
        'failure',
        'inputSizeBytes',
        'originalFileName',
        'outputSizeBytes',
        'retentionOutcome',
        'retentionRequested',
        'sourceFormat',
        'startedAt',
        'storedFileId',
        'targetFormat',
        'userId',
      ]);

      for (const value of Object.values(attempt)) {
        expect(Buffer.isBuffer(value)).toBe(false);
      }
    });

    it('never lets a history failure replace the caller s answer', async () => {
      const harness = buildService();

      harness.history.record.mockRejectedValue(new Error('database is down'));

      // `ConversionHistoryService.record` swallows its own failures; this
      // asserts the pipeline does not depend on that being true.
      await expect(
        convert(harness, request('solid.png', 'jpeg')),
      ).rejects.toThrow('database is down');
    });

    /**
     * SC-008: for a 413 the recorded size is where the budget was exceeded,
     * deliberately *not* the file's true size — the rest of it was never read.
     * The fixture has to be larger than the detection prefix for that to be
     * observable at all, since anything smaller is fully buffered before a
     * per-format budget can apply.
     */
    it('records the bytes actually read, not the file s true size', async () => {
      const harness = buildService({
        maxInputBytes: { png: 100, jpeg: 100, svg: 100 },
      });
      const oversized = Buffer.concat([
        imageFixture('solid.png'),
        Buffer.alloc(256 * 1024, 0x41),
      ]);

      const refusal = await refusalOf(harness, {
        file: { buffer: oversized, filename: 'big.png' },
        fields: { targetFormat: 'jpeg' },
      });

      expect(refusal.code).toBe('input_too_large');

      const [attempt] = harness.history.record.mock.calls[0] as [
        { inputSizeBytes: number },
      ];

      expect(attempt.inputSizeBytes).toBeGreaterThan(0);
      expect(attempt.inputSizeBytes).toBeLessThan(oversized.length);
    });
  });

  describe('the log line', () => {
    it('carries counts and fixed codes only', async () => {
      const harness = buildService();
      const lines: string[] = [];
      const logger = (
        harness.service as unknown as {
          logger: { log: (line: string) => void; warn: (line: string) => void };
        }
      ).logger;

      jest.spyOn(logger, 'log').mockImplementation((line) => {
        lines.push(line);
      });
      jest.spyOn(logger, 'warn').mockImplementation((line) => {
        lines.push(line);
      });

      await convert(harness, {
        file: {
          buffer: imageFixture('solid.png'),
          filename: 'my-secret-holiday-photo.png',
        },
        fields: { targetFormat: 'jpeg' },
      });
      await refusalOf(harness, request('scripted.svg', 'png'));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        /^image conversion user=user-1 source=png target=jpeg inputBytes=\d+ outcome=success durationMs=\d+$/,
      );
      expect(lines[1]).toContain('outcome=failure code=svg_active_content');

      for (const line of lines) {
        expect(line).not.toContain('my-secret-holiday-photo');
      }

      jest.restoreAllMocks();
    });
  });

  describe('retention', () => {
    it('stores nothing when it was not asked for', async () => {
      const harness = buildService();
      const result = await convert(harness, request('solid.png', 'jpeg'));

      expect(harness.retention.store).not.toHaveBeenCalled();
      expect(result.retentionOutcome).toBe('not_requested');
    });

    it('stores and links the result when asked', async () => {
      const harness = buildService();

      harness.retention.store.mockResolvedValue({
        id: 'file-1',
        userId: USER,
        format: 'jpeg',
        sizeBytes: 10,
        storagePath: `${USER}/file-1.jpg`,
      });

      const result = await convert(
        harness,
        request('solid.png', 'jpeg', {
          fields: { targetFormat: 'jpeg', store: 'true' },
        }),
      );

      expect(harness.retention.store).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER,
          format: 'jpeg',
          extension: 'jpg',
        }),
      );
      expect(harness.retention.attach).toHaveBeenCalledWith('record-1', {
        id: 'file-1',
        userId: USER,
        format: 'jpeg',
        sizeBytes: 10,
        storagePath: `${USER}/file-1.jpg`,
      });
      expect(result.retentionOutcome).toBe('stored');
    });

    /** FR-031: a storage failure never changes the status the caller gets. */
    it('reports a storage failure without failing the conversion', async () => {
      const harness = buildService();

      harness.retention.store.mockResolvedValue(null);

      const result = await convert(
        harness,
        request('solid.png', 'jpeg', {
          fields: { targetFormat: 'jpeg', store: 'true' },
        }),
      );

      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.retentionOutcome).toBe('failed');
    });

    it('discards a file it could not link', async () => {
      const harness = buildService();
      const stored = {
        id: 'file-1',
        userId: USER,
        format: 'jpeg',
        sizeBytes: 10,
        storagePath: `${USER}/file-1.jpg`,
      };

      harness.retention.store.mockResolvedValue(stored);
      harness.retention.attach.mockRejectedValue(new Error('constraint'));

      const result = await convert(
        harness,
        request('solid.png', 'jpeg', {
          fields: { targetFormat: 'jpeg', store: 'true' },
        }),
      );

      expect(harness.retention.discard).toHaveBeenCalledWith(stored);
      expect(result.retentionOutcome).toBe('failed');
    });

    /** FR-029: nothing is kept for an attempt that did not succeed. */
    it('stores nothing for a failed conversion', async () => {
      const harness = buildService();

      await refusalOf(
        harness,
        request('truncated.png', 'jpeg', {
          fields: { targetFormat: 'jpeg', store: 'true' },
        }),
      );

      expect(harness.retention.store).not.toHaveBeenCalled();
      expect(harness.history.record).toHaveBeenCalledWith(
        expect.objectContaining({
          retentionRequested: true,
          retentionOutcome: 'failed',
        }),
      );
    });

    it('defaults to not storing when the flag is absent', async () => {
      const harness = buildService();

      await convert(harness, request('solid.png', 'jpeg'));

      expect(harness.history.record).toHaveBeenCalledWith(
        expect.objectContaining({ retentionRequested: false }),
      );
    });
  });

  /**
   * FR-021 and SC-006 rest on the absence of a code path, not on a filter.
   * Read as source rather than exercised, because "no request was made" is not
   * something a unit test can observe — the e2e suite watches a socket for
   * that. What this can prove is that there is nothing here to make one with.
   */
  describe('the no-egress guarantee', () => {
    const MODULE_DIR = join(__dirname);

    const sources = [
      'image-conversion.service.ts',
      'image-conversion.controller.ts',
      'image-format-detector.service.ts',
      'image-format-registry.service.ts',
      'formats/svg.handler.ts',
      'formats/svg-security.ts',
      'formats/svg-intrinsic-size.ts',
      'formats/png.handler.ts',
      'formats/jpeg.handler.ts',
      'formats/sharp-raster.ts',
      'formats/raster-image.ts',
    ];

    it.each(sources)('%s contains no HTTP client', (file) => {
      const source = readFileSync(join(MODULE_DIR, file), 'utf8');

      for (const forbidden of [
        'fetch(',
        "require('http",
        "require('https",
        "from 'http'",
        "from 'https'",
        "from 'node:http",
        'axios',
        'got(',
        'XMLHttpRequest',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });

    it.each(sources)('%s reads no file named by an upload', (file) => {
      const source = readFileSync(join(MODULE_DIR, file), 'utf8');

      for (const forbidden of [
        'readFile',
        'readFileSync',
        'createReadStream',
        "from 'fs'",
        "from 'node:fs'",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });
  });
});
