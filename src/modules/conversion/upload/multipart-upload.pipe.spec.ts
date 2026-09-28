import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'stream';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionController } from '@/modules/conversion/conversion.controller';
import { ConversionFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';
import { ConversionService } from '@/modules/conversion/conversion.service';
import type { DocumentUpload } from '@/modules/conversion/conversion.service';
import { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { CsvHandler } from '@/modules/conversion/formats/csv.handler';
import type { ConversionLimits } from '@/modules/conversion/formats/format-handler';
import { JsonHandler } from '@/modules/conversion/formats/json.handler';
import { XmlHandler } from '@/modules/conversion/formats/xml.handler';
import { YamlHandler } from '@/modules/conversion/formats/yaml.handler';
import type { ConversionHistoryService } from '@/modules/conversion/history/conversion-history.service';
import type { ConversionRetentionService } from '@/modules/conversion/history/conversion-retention.service';
import { ImageConversionController } from '@/modules/image-conversion/image-conversion.controller';
import { buildService } from '@/modules/image-conversion/image-conversion.test-support';
import { ImageUploadPipe } from '@/modules/image-conversion/image-upload.pipe';

import { DocumentUploadPipe } from './document-upload.pipe';
import type { MultipartPart, MultipartSource } from './multipart-upload';

const limits: ConversionLimits = {
  maxInputBytes: {
    [ConversionFormat.CSV]: 1_000,
    [ConversionFormat.JSON]: 1_000,
    [ConversionFormat.XML]: 1_000,
    [ConversionFormat.YAML]: 1_000,
  },
  maxOutputBytes: 1_000_000,
  maxDepth: 64,
  maxNodes: 200_000,
  maxCsvColumns: 1024,
  timeoutMs: 10_000,
  maxConcurrent: 1,
};

const CSV = 'name,age\r\nAnn,30\r\n';

function chunks(buffer: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    out.push(buffer.subarray(offset, offset + size));
  }
  return out.length > 0 ? out : [Buffer.alloc(0)];
}

function documentPipe(): DocumentUploadPipe {
  const registry = new FormatRegistryService(
    [new CsvHandler(), new JsonHandler(), new XmlHandler(), new YamlHandler()],
    limits,
  );
  const service = new ConversionService(
    registry,
    new FormatDetectorService(registry),
    { record: jest.fn() } as unknown as ConversionHistoryService,
    { finalize: jest.fn() } as unknown as ConversionRetentionService,
    limits,
  );

  return new DocumentUploadPipe(service, registry);
}

function file(
  body: string | Buffer = CSV,
  fieldname = 'file',
): Extract<MultipartPart, { type: 'file' }> & { drained: () => boolean } {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  let drained = false;

  return {
    type: 'file',
    fieldname,
    filename: 'sample.csv',
    // In pieces, as busboy delivers it: the budget is enforced per chunk.
    file: Readable.from(chunks(buffer, 256)),
    toBuffer: () => {
      drained = true;
      return Promise.resolve(buffer);
    },
    drained: () => drained,
  };
}

function field(fieldname: string, value: string): MultipartPart {
  return { type: 'field', fieldname, value };
}

function request(
  parts: MultipartPart[],
  options: { multipart?: boolean; throwAfter?: Error } = {},
): MultipartSource {
  return {
    isMultipart: () => options.multipart !== false,
    parts: () =>
      (async function* () {
        for (const part of parts) {
          yield await Promise.resolve(part);
        }
        if (options.throwAfter) {
          throw options.throwAfter;
        }
      })(),
  };
}

async function refusal(
  upload: Promise<DocumentUpload>,
): Promise<ConversionException> {
  const result = await upload;

  if (result.ok) {
    throw new Error('expected the upload to be refused');
  }

  expect(result.failure).toBeInstanceOf(ConversionException);
  return result.failure as ConversionException;
}

/** What `@fastify/multipart` raises from the iterator past a limit. */
function transportError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('MultipartUploadPipe', () => {
  it('is what both conversion routes read their body through', () => {
    const pipesOf = (controller: object): unknown[] => {
      const args = (Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        controller,
        'convert',
      ) ?? {}) as Record<string, { pipes?: unknown[] }>;

      return Object.values(args).flatMap((arg) => arg.pipes ?? []);
    };

    expect(pipesOf(ConversionController)).toContain(DocumentUploadPipe);
    expect(pipesOf(ImageConversionController)).toContain(ImageUploadPipe);
  });

  describe('a well-formed upload', () => {
    it.each([
      ['after the file', false],
      ['before the file', true],
    ])('accepts the fields %s', async (_label, fieldsFirst) => {
      const fields = [field('targetFormat', 'json'), field('store', 'true')];
      const parts = fieldsFirst ? [...fields, file()] : [file(), ...fields];

      const upload = await documentPipe().transform(request(parts));

      expect(upload).toMatchObject({
        ok: true,
        targetFormat: ConversionFormat.JSON,
        received: { sourceFormat: ConversionFormat.CSV, text: CSV },
        attempt: {
          originalFileName: 'sample.csv',
          sourceFormat: ConversionFormat.CSV,
          targetFormat: ConversionFormat.JSON,
          inputSizeBytes: Buffer.byteLength(CSV),
          retentionRequested: true,
        },
      });
      expect(upload.attempt.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('refusals are returned, not thrown, with what was learned', () => {
    it('reports a non-multipart request as a missing file', async () => {
      const error = await refusal(
        documentPipe().transform(request([], { multipart: false })),
      );

      expect(error.code).toBe(ConversionErrorCode.MISSING_FILE);
    });

    it('reports a request with no file part', async () => {
      const error = await refusal(
        documentPipe().transform(request([field('targetFormat', 'json')])),
      );

      expect(error.code).toBe(ConversionErrorCode.MISSING_FILE);
    });

    it.each([
      ['a missing target', [file()], ConversionErrorCode.MISSING_TARGET_FORMAT],
      [
        'an unknown target',
        [file(), field('targetFormat', 'pdf')],
        ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
      ],
      [
        'a malformed store flag',
        [file(), field('targetFormat', 'json'), field('store', 'yes')],
        ConversionErrorCode.INVALID_STORE_FLAG,
      ],
      [
        'an unknown field',
        [file(), field('targetFormat', 'json'), field('colour', 'red')],
        ConversionErrorCode.UNEXPECTED_PART,
      ],
      [
        'a repeated field',
        [file(), field('targetFormat', 'json'), field('targetFormat', 'yaml')],
        ConversionErrorCode.UNEXPECTED_PART,
      ],
    ])('reports %s', async (_label, parts, code) => {
      const error = await refusal(documentPipe().transform(request(parts)));

      expect(error.code).toBe(code);
    });

    it('drains, then refuses, a second file part', async () => {
      const second = file(CSV, 'other');

      const error = await refusal(
        documentPipe().transform(
          request([file(), second, field('targetFormat', 'json')]),
        ),
      );

      expect(error.code).toBe(ConversionErrorCode.UNEXPECTED_PART);
      // An undrained part stalls busboy's iterator.
      expect(second.drained()).toBe(true);
    });

    it('keeps what it knew when the file is refused', async () => {
      const upload = await documentPipe().transform(
        request([field('store', 'true'), file('x'.repeat(200_000))]),
      );

      expect(upload.ok).toBe(false);
      expect(upload.attempt).toMatchObject({
        originalFileName: 'sample.csv',
        retentionRequested: true,
      });
      // Where the budget was hit (past the 64 KiB detection prefix), not the
      // file's true size: the rest of it was never read.
      expect(upload.attempt.inputSizeBytes).toBeGreaterThan(1_000);
      expect(upload.attempt.inputSizeBytes).toBeLessThan(200_000);
    });
  });

  /**
   * FINDING 3 of the code review: the document route let a transport limit
   * raised from the parts iterator escape as a bare library error — a 500
   * `internal_error` to the caller and in their history — where the image
   * route reported it as a refusal. Both now share one translation.
   */
  describe('transport limits raised by @fastify/multipart', () => {
    it.each(['FST_FILES_LIMIT', 'FST_REQ_FILE_TOO_LARGE', 'FST_PARTS_LIMIT'])(
      'reports %s as input_too_large on the document route',
      async (code) => {
        const error = await refusal(
          documentPipe().transform(
            request([file(), field('targetFormat', 'json')], {
              throwAfter: transportError(code),
            }),
          ),
        );

        expect(error.code).toBe(ConversionErrorCode.INPUT_TOO_LARGE);
        expect(error.params).toEqual({ limit: 1_000 });
      },
    );

    it('reports FST_FILES_LIMIT as input_too_large on the image route too', async () => {
      const harness = buildService();

      const upload = await harness.pipe.transform(
        request([], { throwAfter: transportError('FST_FILES_LIMIT') }),
      );

      expect(upload.ok).toBe(false);
      expect((upload as { failure: ConversionException }).failure.code).toBe(
        ConversionErrorCode.INPUT_TOO_LARGE,
      );
    });

    it('names the limit when busboy cuts the file short to enforce it', async () => {
      // A second file under `files: 1`: busboy destroys the part in flight,
      // so the file read fails as a bare premature close, and the iterator
      // has the real reason queued.
      const cutShort = new Readable({
        read() {
          this.destroy(
            Object.assign(new Error('Premature close'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
            }),
          );
        },
      });
      const source: MultipartSource = {
        isMultipart: () => true,
        parts: () =>
          (async function* () {
            yield await Promise.resolve<MultipartPart>({
              type: 'file',
              fieldname: 'file',
              filename: 'a.csv',
              file: cutShort,
              toBuffer: () => Promise.resolve(Buffer.alloc(0)),
            });
            throw transportError('FST_FILES_LIMIT');
          })(),
      };

      const error = await refusal(documentPipe().transform(source));

      expect(error.code).toBe(ConversionErrorCode.INPUT_TOO_LARGE);
    });

    it('passes any other error through unchanged', async () => {
      const boom = new Error('socket hang up');

      const upload = await documentPipe().transform(
        request([file()], { throwAfter: boom }),
      );

      expect(upload).toMatchObject({ ok: false, failure: boom });
    });
  });
});
