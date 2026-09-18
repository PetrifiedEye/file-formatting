import { Readable } from 'stream';

import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionRetentionOutcome } from '@/modules/conversion/conversion.enums';
import { ConversionHistoryService } from '@/modules/conversion/conversion-history.service';
import { ConversionRetentionService } from '@/modules/conversion/conversion-retention.service';

import { JpegHandler } from './formats/jpeg.handler';
import { PngHandler } from './formats/png.handler';
import { SvgHandler } from './formats/svg.handler';
import { TEST_LIMITS } from './formats/image-test-support';
import type {
  ImageConversionLimits,
  ImageFormatHandler,
} from './formats/image-format-handler';
import { ImageConversionService } from './image-conversion.service';
import type {
  MultipartPart,
  MultipartSource,
} from './image-conversion.service';
import { ImageFormatDetectorService } from './image-format-detector.service';
import { ImageFormatRegistryService } from './image-format-registry.service';

/**
 * A wired-up service over the real handlers, with history and retention
 * doubled.
 *
 * The handlers are real on purpose: the properties these specs assert — the
 * order of refusals, what reaches history, that nothing is rendered before the
 * size check — are properties of the *pipeline over real decoders*, and a
 * stubbed handler would let a regression in one hide behind the other.
 */
export interface ServiceHarness {
  service: ImageConversionService;
  history: { record: jest.Mock };
  retention: {
    finalize: jest.Mock;
    store: jest.Mock;
    attach: jest.Mock;
    discard: jest.Mock;
  };
  limits: ImageConversionLimits;
}

export function buildService(
  overrides: Partial<ImageConversionLimits> = {},
  handlers?: ImageFormatHandler[],
): ServiceHarness {
  const limits: ImageConversionLimits = { ...TEST_LIMITS, ...overrides };
  const registered = handlers ?? [
    new PngHandler(),
    new JpegHandler(),
    new SvgHandler(),
  ];

  const registry = new ImageFormatRegistryService(registered, limits);
  const detector = new ImageFormatDetectorService(registry);

  const history = { record: jest.fn().mockResolvedValue('record-1') };
  const retention = {
    finalize: jest.fn().mockResolvedValue({
      retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
      storedFileId: null,
      auditOutcome: null,
    }),
    store: jest.fn(),
    attach: jest.fn().mockResolvedValue(true),
    discard: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ImageConversionService(
    registry,
    detector,
    history as unknown as ConversionHistoryService,
    retention as unknown as ConversionRetentionService,
    limits,
  );

  return { service, history, retention, limits };
}

export interface RequestSpec {
  file?: { buffer: Buffer; filename?: string; fieldname?: string };
  /** Extra file parts, for the `unexpected_part` cases. */
  extraFiles?: { buffer: Buffer; fieldname: string }[];
  fields?: Record<string, string>;
  /** Field parts repeated or misnamed, in the order they arrive. */
  rawFields?: { fieldname: string; value: string }[];
  multipart?: boolean;
  /** Emit the fields before the file, which is legal and must still work. */
  fieldsFirst?: boolean;
}

/**
 * A file part's stream, delivered in chunks.
 *
 * Chunked deliberately: a real multipart stream arrives in pieces, and a
 * single-chunk double would hide the property the byte budget exists for —
 * the reader stops consuming the moment the budget is passed, so an oversized
 * upload is never read to the end (SC-008). Handing it the whole buffer at
 * once would make that untestable and quietly always "pass".
 */
const CHUNK_BYTES = 16 * 1024;

function chunked(buffer: Buffer): Readable {
  const chunks: Buffer[] = [];

  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + CHUNK_BYTES));
  }

  return Readable.from(chunks.length > 0 ? chunks : [Buffer.alloc(0)]);
}

/** A multipart body as an async iterable, without a server in the way. */
export function fakeRequest(spec: RequestSpec): MultipartSource {
  const parts: MultipartPart[] = [];

  const fileParts: MultipartPart[] = [];

  if (spec.file) {
    fileParts.push({
      type: 'file',
      fieldname: spec.file.fieldname ?? 'file',
      filename: spec.file.filename ?? 'upload.bin',
      file: chunked(spec.file.buffer),
      toBuffer: () => Promise.resolve(spec.file!.buffer),
    });
  }

  for (const extra of spec.extraFiles ?? []) {
    fileParts.push({
      type: 'file',
      fieldname: extra.fieldname,
      filename: 'extra.bin',
      file: chunked(extra.buffer),
      toBuffer: () => Promise.resolve(extra.buffer),
    });
  }

  const fieldParts: MultipartPart[] = [
    ...Object.entries(spec.fields ?? {}).map(
      ([fieldname, value]): MultipartPart => ({
        type: 'field',
        fieldname,
        value,
      }),
    ),
    ...(spec.rawFields ?? []).map(
      ({ fieldname, value }): MultipartPart => ({
        type: 'field',
        fieldname,
        value,
      }),
    ),
  ];

  parts.push(
    ...(spec.fieldsFirst
      ? [...fieldParts, ...fileParts]
      : [...fileParts, ...fieldParts]),
  );

  return {
    isMultipart: () => spec.multipart !== false,
    // Async so it satisfies the `for await` the service uses; each part is
    // already in hand, so there is nothing to await between them.
    parts: () =>
      (async function* () {
        for (const part of parts) {
          yield await Promise.resolve(part);
        }
      })(),
  };
}

export const FORMATS = ImageFormat;
