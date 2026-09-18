import { Readable } from 'stream';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

import { ConversionController } from './conversion.controller';
import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionService } from './conversion.service';
import { ConversionHistoryService } from './conversion-history.service';
import { ConversionRetentionService } from './conversion-retention.service';
import { FormatDetectorService } from './format-detector.service';
import { FormatRegistryService } from './format-registry.service';
import { CsvHandler } from './formats/csv.handler';
import type { ConversionLimits, FormatHandler } from './formats/format-handler';
import { JsonHandler } from './formats/json.handler';
import { XmlHandler } from './formats/xml.handler';
import { YamlHandler } from './formats/yaml.handler';

const limits: ConversionLimits = {
  maxInputBytes: {
    [ConversionFormat.CSV]: 1_000_000,
    [ConversionFormat.JSON]: 1_000_000,
    [ConversionFormat.XML]: 1_000_000,
    [ConversionFormat.YAML]: 1_000_000,
  },
  maxOutputBytes: 1_000_000,
  maxDepth: 64,
  maxNodes: 200_000,
  maxCsvColumns: 1024,
  timeoutMs: 10_000,
  maxConcurrent: 4,
};

const CSV = 'name,age\r\nAnn,30\r\n';

type Part =
  | { type: 'file'; fieldname: string; filename: string; body: string }
  | { type: 'field'; fieldname: string; value: string };

function filePart(
  body = CSV,
  fieldname = 'file',
  filename = 'sample.csv',
): Part {
  return { type: 'file', fieldname, filename, body };
}

function field(fieldname: string, value: string): Part {
  return { type: 'field', fieldname, value };
}

/** A FastifyRequest stand-in that yields the given parts, busboy-style. */
function requestWith(parts: Part[], multipart = true) {
  // busboy's part iterator is async; this stand-in has nothing to wait for.
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* iterate() {
    for (const part of parts) {
      if (part.type === 'file') {
        const buffer = Buffer.from(part.body, 'utf8');
        yield {
          type: 'file' as const,
          fieldname: part.fieldname,
          filename: part.filename,
          file: Readable.from([buffer]),
          toBuffer: () => Promise.resolve(buffer),
        };
        continue;
      }

      yield {
        type: 'field' as const,
        fieldname: part.fieldname,
        value: part.value,
      };
    }
  }

  return {
    user: { id: 'user-1', roles: [] },
    isMultipart: () => multipart,
    parts: () => iterate(),
  } as never;
}

function replySpy() {
  const headers: Record<string, string> = {};
  const sent: Buffer[] = [];
  const statuses: number[] = [];
  const reply = {
    status(code: number) {
      statuses.push(code);
      return reply;
    },
    header(name: string, value: string) {
      headers[name] = value;
      return reply;
    },
    send(payload: Buffer) {
      sent.push(payload);
      return reply;
    },
  };

  return { reply: reply as never, headers, sent, statuses };
}

function controllerWith(
  handlers: FormatHandler[] = [
    new CsvHandler(),
    new JsonHandler(),
    new XmlHandler(),
    new YamlHandler(),
  ],
): {
  controller: ConversionController;
  registry: FormatRegistryService;
  retention: ConversionRetentionService;
} {
  const registry = new FormatRegistryService(handlers, limits);
  const retention = {
    finalize: jest.fn().mockResolvedValue({
      retentionOutcome: 'not_requested',
      storedFileId: null,
      auditOutcome: null,
    }),
    store: jest.fn().mockResolvedValue(null),
    attach: jest.fn().mockResolvedValue(true),
    discard: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversionRetentionService;
  const service = new ConversionService(
    registry,
    new FormatDetectorService(registry),
    {
      record: jest.fn().mockResolvedValue('record-1'),
    } as unknown as ConversionHistoryService,
    retention,
    limits,
  );

  return {
    controller: new ConversionController(service, registry),
    registry,
    retention,
  };
}

describe('ConversionController', () => {
  describe('access control', () => {
    it('sits behind JwtAuthGuard, so nothing is read without a session', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        ConversionController,
      ) as unknown[];

      expect(guards).toContain(JwtAuthGuard);
    });
  });

  describe('collecting parts', () => {
    it('accepts a file plus targetFormat', async () => {
      const { controller } = controllerWith();
      const { reply, sent } = replySpy();

      await controller.convert(
        requestWith([filePart(), field('targetFormat', 'json')]),
        reply,
      );

      expect(JSON.parse(sent[0].toString('utf8'))).toEqual([
        { name: 'Ann', age: '30' },
      ]);
    });

    it('accepts targetFormat arriving before the file', async () => {
      const { controller } = controllerWith();
      const { reply, sent } = replySpy();

      await controller.convert(
        requestWith([field('targetFormat', 'json'), filePart()]),
        reply,
      );

      expect(sent).toHaveLength(1);
    });

    it('accepts the optional store flag', async () => {
      const { controller } = controllerWith();
      const { reply, sent } = replySpy();

      await controller.convert(
        requestWith([
          filePart(),
          field('targetFormat', 'json'),
          field('store', 'false'),
        ]),
        reply,
      );

      expect(sent).toHaveLength(1);
    });

    it.each([
      ['no file part', [field('targetFormat', 'json')], 'missing_file'],
      [
        'a file under another name',
        [filePart(CSV, 'document'), field('targetFormat', 'json')],
        'unexpected_part',
      ],
      [
        'a second file part',
        [filePart(), filePart(), field('targetFormat', 'json')],
        'unexpected_part',
      ],
      [
        'an unrecognized field',
        [filePart(), field('targetFormat', 'json'), field('colour', 'red')],
        'unexpected_part',
      ],
      [
        'a duplicate field',
        [
          filePart(),
          field('targetFormat', 'json'),
          field('targetFormat', 'xml'),
        ],
        'unexpected_part',
      ],
      ['no targetFormat', [filePart()], 'missing_target_format'],
      [
        'an unknown targetFormat',
        [filePart(), field('targetFormat', 'toml')],
        'unsupported_target_format',
      ],
      [
        'a malformed store flag',
        [filePart(), field('targetFormat', 'json'), field('store', 'yes')],
        'invalid_store_flag',
      ],
    ] as [string, Part[], string][])(
      'refuses %s with code %s',
      async (_label, parts, code) => {
        const { controller } = controllerWith();
        const { reply } = replySpy();

        await expect(
          controller.convert(requestWith(parts), reply),
        ).rejects.toMatchObject({ code });
      },
    );

    it('refuses a request that is not multipart at all', async () => {
      const { controller } = controllerWith();
      const { reply } = replySpy();

      await expect(
        controller.convert(requestWith([], false), reply),
      ).rejects.toMatchObject({ code: 'missing_file' });
    });
  });

  describe('the success response', () => {
    it.each([
      ['json', 'application/json; charset=utf-8', 'converted.json'],
      ['xml', 'application/xml; charset=utf-8', 'converted.xml'],
      ['yaml', 'application/yaml; charset=utf-8', 'converted.yaml'],
    ])(
      'labels a %s result exactly as the contract says',
      async (target, contentType, filename) => {
        const { controller } = controllerWith();
        const { reply, headers } = replySpy();

        await controller.convert(
          requestWith([filePart(), field('targetFormat', target)]),
          reply,
        );

        expect(headers['Content-Type']).toBe(contentType);
        expect(headers['Content-Disposition']).toBe(
          `attachment; filename="${filename}"`,
        );
      },
    );

    it('names the attachment "converted", not after the upload', async () => {
      const { controller } = controllerWith();
      const { reply, headers } = replySpy();

      await controller.convert(
        requestWith([
          filePart(CSV, 'file', 'payroll-2026-confidential.csv'),
          field('targetFormat', 'json'),
        ]),
        reply,
      );

      expect(headers['Content-Disposition']).toBe(
        'attachment; filename="converted.json"',
      );
      expect(headers['Content-Disposition']).not.toContain('payroll');
    });

    it.each([
      ['not requested', false, 'not-requested'],
      ['requested and stored', true, 'stored'],
    ])(
      'reports retention %s in the header',
      async (_label, requested, expected) => {
        const { controller, retention } = controllerWith();
        if (requested) {
          (retention.finalize as jest.Mock).mockResolvedValue({
            retentionOutcome: 'stored',
            storedFileId: 'file-1',
            auditOutcome: 'success',
          });
        }

        const { reply, headers } = replySpy();

        await controller.convert(
          requestWith([
            filePart(),
            field('targetFormat', 'json'),
            field('store', requested ? 'true' : 'false'),
          ]),
          reply,
        );

        expect(headers['X-Conversion-Retention']).toBe(expected);
      },
    );

    it('still returns the file when only keeping a copy failed', async () => {
      // FR-028: the conversion succeeded, so withholding the result would be
      // the worse lie. The header carries the bad news instead.
      const { controller, retention } = controllerWith();
      (retention.finalize as jest.Mock).mockResolvedValue({
        retentionOutcome: 'failed',
        storedFileId: null,
        auditOutcome: 'storage_failed',
      });
      const { reply, headers, sent, statuses } = replySpy();

      await controller.convert(
        requestWith([
          filePart(),
          field('targetFormat', 'json'),
          field('store', 'true'),
        ]),
        reply,
      );

      expect(statuses).toEqual([200]);
      expect(headers['X-Conversion-Retention']).toBe('failed');
      expect(JSON.parse(sent[0].toString('utf8'))).toEqual([
        { name: 'Ann', age: '30' },
      ]);
    });

    it('sends the converted buffer as the body', async () => {
      const { controller } = controllerWith();
      const { reply, sent } = replySpy();

      await controller.convert(
        requestWith([filePart(), field('targetFormat', 'xml')]),
        reply,
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].toString('utf8')).toContain('<name>Ann</name>');
    });

    it('answers 200, not the 201 Nest defaults POST to', async () => {
      // A conversion creates no resource.
      const { controller } = controllerWith();
      const { reply, statuses } = replySpy();

      await controller.convert(
        requestWith([filePart(), field('targetFormat', 'json')]),
        reply,
      );

      expect(statuses).toEqual([200]);
    });

    it('refuses converting a format to itself', async () => {
      const { controller } = controllerWith();
      const { reply } = replySpy();

      await expect(
        controller.convert(
          requestWith([filePart(), field('targetFormat', 'csv')]),
          reply,
        ),
      ).rejects.toMatchObject({ code: 'same_format' });
    });
  });

  describe('failures never look like a file', () => {
    it('sets no response header when the conversion fails', async () => {
      const { controller } = controllerWith();
      const { reply, headers, sent } = replySpy();

      await expect(
        controller.convert(
          requestWith([
            filePart('<a><b></a>', 'file', 'broken.xml'),
            field('targetFormat', 'json'),
          ]),
          reply,
        ),
      ).rejects.toBeInstanceOf(ConversionException);

      // Nest renders the exception as JSON; no attachment headers were set,
      // so a caller can never mistake an error for a truncated download.
      expect(headers).toEqual({});
      expect(sent).toHaveLength(0);
    });

    it('sets no header when the request itself is malformed', async () => {
      const { controller } = controllerWith();
      const { reply, headers } = replySpy();

      await expect(
        controller.convert(requestWith([filePart()]), reply),
      ).rejects.toBeInstanceOf(ConversionException);

      expect(headers).toEqual({});
    });
  });

  describe('GET /api/convert/formats', () => {
    it('advertises four sources, each with the other three', () => {
      const { controller } = controllerWith();

      expect(controller.supportedFormats().formats).toEqual([
        {
          source: 'csv',
          mediaType: 'text/csv',
          extension: 'csv',
          maxInputBytes: 1_000_000,
          targets: ['json', 'xml', 'yaml'],
        },
        {
          source: 'json',
          mediaType: 'application/json',
          extension: 'json',
          maxInputBytes: 1_000_000,
          targets: ['csv', 'xml', 'yaml'],
        },
        {
          source: 'xml',
          mediaType: 'application/xml',
          extension: 'xml',
          maxInputBytes: 1_000_000,
          targets: ['csv', 'json', 'yaml'],
        },
        {
          source: 'yaml',
          mediaType: 'application/yaml',
          extension: 'yaml',
          maxInputBytes: 1_000_000,
          targets: ['csv', 'json', 'xml'],
        },
      ]);
    });

    it('never advertises a format onto itself', () => {
      const { controller } = controllerWith();

      for (const entry of controller.supportedFormats().formats) {
        expect(entry.targets).not.toContain(entry.source);
      }
    });

    it('shrinks when a handler is not registered — no edit here', () => {
      const { controller } = controllerWith([
        new CsvHandler(),
        new JsonHandler(),
      ]);
      const { formats } = controller.supportedFormats();

      expect(formats.map((entry) => entry.source)).toEqual(['csv', 'json']);
      expect(formats[0].targets).toEqual(['json']);
    });

    it('grows when a handler is added — still no edit here (FR-030)', () => {
      // A fifth format appears as a new source *and* widens every existing
      // source's targets, because the list is derived rather than written down.
      const json = new JsonHandler();
      const toml: FormatHandler = {
        format: 'toml' as ConversionFormat,
        mediaType: 'application/toml',
        extension: 'toml',
        detectionPriority: 50,
        sniffIsConclusive: false,
        sniff: (prefix, named) => json.sniff(prefix) || named,
        read: (input) => json.read(input),
        write: (node) => json.write(node),
      };

      const before = controllerWith().controller.supportedFormats().formats;
      const after = controllerWith([
        new CsvHandler(),
        new JsonHandler(),
        new XmlHandler(),
        new YamlHandler(),
        toml,
      ]).controller.supportedFormats().formats;

      expect(before).toHaveLength(4);
      expect(after).toHaveLength(5);
      expect(after.map((entry) => entry.source)).toContain('toml');

      for (const entry of after) {
        if ((entry.source as string) !== 'toml') {
          expect(entry.targets).toContain('toml');
          expect(entry.targets).toHaveLength(4);
        }
      }
    });

    it('reports each source its own configured limit', () => {
      const { controller } = controllerWith();

      for (const entry of controller.supportedFormats().formats) {
        expect(entry.maxInputBytes).toBe(limits.maxInputBytes[entry.source]);
      }
    });
  });

  describe('registry-derived behaviour', () => {
    it('accepts only targets that are actually registered', async () => {
      // With YAML unregistered, `targetFormat=yaml` is a 415 — with no edit
      // to the controller.
      const { controller } = controllerWith([
        new CsvHandler(),
        new JsonHandler(),
        new XmlHandler(),
      ]);
      const { reply } = replySpy();

      await expect(
        controller.convert(
          requestWith([filePart(), field('targetFormat', 'yaml')]),
          reply,
        ),
      ).rejects.toMatchObject({ code: 'unsupported_target_format' });
    });
  });
});
