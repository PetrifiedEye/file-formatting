import { Readable } from 'stream';

import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionHistoryService } from './conversion-history.service';
import { ConversionRetentionService } from './conversion-retention.service';
import { ConversionResult, ConversionService } from './conversion.service';
import { FormatDetectorService } from './format-detector.service';
import { FormatRegistryService } from './format-registry.service';
import { CsvHandler } from './formats/csv.handler';
import type { ConversionLimits } from './formats/format-handler';
import { JsonHandler } from './formats/json.handler';
import { XmlHandler } from './formats/xml.handler';
import { YamlHandler } from './formats/yaml.handler';
import { UploadReader } from './upload-reader';

const baseLimits: ConversionLimits = {
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

/** The same two records, spelled in each of the four formats. */
const FIXTURES: Record<ConversionFormat, string> = {
  [ConversionFormat.CSV]: 'name,age\r\nAnn,30\r\nBob,41\r\n',
  [ConversionFormat.JSON]: JSON.stringify(
    [
      { name: 'Ann', age: '30' },
      { name: 'Bob', age: '41' },
    ],
    null,
    2,
  ),
  [ConversionFormat.XML]:
    '<rows><row><name>Ann</name><age>30</age></row>' +
    '<row><name>Bob</name><age>41</age></row></rows>',
  [ConversionFormat.YAML]:
    '- name: Ann\n  age: "30"\n- name: Bob\n  age: "41"\n',
};

/** History is exercised by its own spec; here it only has to not get in the way. */
function historyStub(): ConversionHistoryService {
  return {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversionHistoryService;
}

/**
 * Retention has its own spec; here it only has to stay out of the way — and,
 * by never storing, keep every assertion about the conversion itself honest.
 */
function retentionStub(): ConversionRetentionService {
  return {
    store: jest.fn().mockResolvedValue(null),
    attach: jest.fn().mockResolvedValue(true),
    discard: jest.fn().mockResolvedValue(undefined),
  } as unknown as ConversionRetentionService;
}

function serviceWith(
  overrides: Partial<ConversionLimits> = {},
): ConversionService {
  const limits = { ...baseLimits, ...overrides };
  const registry = new FormatRegistryService(
    [new CsvHandler(), new JsonHandler(), new XmlHandler(), new YamlHandler()],
    limits,
  );

  return new ConversionService(
    registry,
    new FormatDetectorService(registry),
    historyStub(),
    retentionStub(),
    limits,
  );
}

function readerFor(body: string | Buffer): UploadReader {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

  return new UploadReader(Readable.from([buffer]), { prefixBytes: 65536 });
}

/**
 * Drive both halves of the pipeline the way the controller does: consume the
 * upload while the part stream is open, then convert once the fields are known.
 */
function run(
  service: ConversionService,
  body: string | Buffer,
  targetFormat: ConversionFormat,
  originalFileName = 'upload',
): Promise<ConversionResult> {
  return service
    .receive(readerFor(body), originalFileName)
    .then((received) => service.convert(received, targetFormat));
}

const ALL = Object.values(ConversionFormat);

describe('ConversionService', () => {
  describe('all twelve directions', () => {
    const directions = ALL.flatMap((source) =>
      ALL.filter((target) => target !== source).map(
        (target) => [source, target] as const,
      ),
    );

    it('covers exactly twelve', () => {
      expect(directions).toHaveLength(12);
    });

    it.each(directions)('converts %s to %s', async (source, target) => {
      const result = await run(
        serviceWith(),
        FIXTURES[source],
        target,
        `sample.${source}`,
      );

      expect(result.sourceFormat).toBe(source);
      expect(result.targetFormat).toBe(target);
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.extension).toBe(target);
    });

    it.each(directions)(
      'carries the data across %s to %s',
      async (source, target) => {
        const result = await run(
          serviceWith(),
          FIXTURES[source],
          target,
          `sample.${source}`,
        );
        const text = result.buffer.toString('utf8');

        expect(text).toContain('Ann');
        expect(text).toContain('Bob');
        expect(text).toContain('41');
      },
    );
  });

  describe('round trips (SC-001)', () => {
    const roundTrip = async (
      body: string,
      via: ConversionFormat,
      back: ConversionFormat,
      name: string,
    ): Promise<string> => {
      const service = serviceWith();
      const first = await run(service, body, via, name);
      const second = await run(service, first.buffer, back, `step.${via}`);

      return second.buffer.toString('utf8');
    };

    it('CSV to JSON to CSV is exact', async () => {
      await expect(
        roundTrip(
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.JSON,
          ConversionFormat.CSV,
          'sample.csv',
        ),
      ).resolves.toBe(FIXTURES[ConversionFormat.CSV]);
    });

    it('CSV to YAML to CSV is exact', async () => {
      await expect(
        roundTrip(
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.YAML,
          ConversionFormat.CSV,
          'sample.csv',
        ),
      ).resolves.toBe(FIXTURES[ConversionFormat.CSV]);
    });

    it('JSON to YAML to JSON is exact', async () => {
      const original = `${FIXTURES[ConversionFormat.JSON]}\n`;

      await expect(
        roundTrip(
          original,
          ConversionFormat.YAML,
          ConversionFormat.JSON,
          'sample.json',
        ),
      ).resolves.toBe(original);
    });
  });

  describe('encoding at the boundary', () => {
    it('consumes a BOM and never emits one', async () => {
      const withBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(FIXTURES[ConversionFormat.CSV], 'utf8'),
      ]);

      const result = await run(
        serviceWith(),
        withBom,
        ConversionFormat.JSON,
        'bom.csv',
      );

      expect(result.buffer[0]).not.toBe(0xef);
      expect(JSON.parse(result.buffer.toString('utf8'))).toEqual([
        { name: 'Ann', age: '30' },
        { name: 'Bob', age: '41' },
      ]);
    });

    it('carries Unicode through unchanged (FR-010)', async () => {
      const value = 'café 日本語 🇵🇱';
      const result = await run(
        serviceWith(),
        JSON.stringify([{ v: value }]),
        ConversionFormat.YAML,
        'sample.json',
      );

      expect(result.buffer.toString('utf8')).toContain(value);
    });

    it('refuses invalid UTF-8', async () => {
      const bad = Buffer.concat([
        Buffer.from('name,age\r\n', 'utf8'),
        Buffer.from([0xff, 0xfe]),
      ]);

      await expect(
        run(serviceWith(), bad, ConversionFormat.JSON, 'x.csv'),
      ).rejects.toMatchObject({ code: 'invalid_encoding' });
    });
  });

  describe('refusals', () => {
    it('refuses a zero-byte upload', async () => {
      await expect(
        run(serviceWith(), '', ConversionFormat.JSON),
      ).rejects.toMatchObject({ code: 'empty_file' });
    });

    it('refuses converting a format to itself', async () => {
      const failure = run(
        serviceWith(),
        FIXTURES[ConversionFormat.CSV],
        ConversionFormat.CSV,
        'sample.csv',
      );

      await expect(failure).rejects.toBeInstanceOf(ConversionException);
      await expect(failure).rejects.toMatchObject({ code: 'same_format' });
      await failure.catch((error: ConversionException) => {
        // 400 and not 415: both formats are supported, the request is wrong.
        expect(error.getStatus()).toBe(400);
      });
    });

    it('refuses content matching no supported format', async () => {
      await expect(
        run(
          serviceWith(),
          'PNG IHDR gAMA sRGB pHYs',
          ConversionFormat.JSON,
          'b.png',
        ),
      ).rejects.toMatchObject({ code: 'unsupported_source_format' });
    });

    it('refuses input past the structural limits', async () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 20; i += 1) {
        deep = { child: deep };
      }

      await expect(
        run(
          serviceWith({ maxDepth: 5 }),
          JSON.stringify(deep),
          ConversionFormat.YAML,
          's.json',
        ),
      ).rejects.toMatchObject({ code: 'structure_limit_exceeded' });
    });

    it('refuses an output past the ceiling', async () => {
      await expect(
        run(
          serviceWith({ maxOutputBytes: 10 }),
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.JSON,
          'sample.csv',
        ),
      ).rejects.toMatchObject({ code: 'output_too_large' });
    });

    it('refuses once the deadline has passed', async () => {
      // A zero budget expires before the first check.
      await expect(
        run(
          serviceWith({ timeoutMs: 0 }),
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.JSON,
          'sample.csv',
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
    });
  });

  describe('per-format size limits (FR-016, US5 scenario 3)', () => {
    const tightCsv = {
      maxInputBytes: {
        [ConversionFormat.CSV]: 8,
        [ConversionFormat.JSON]: 1_000_000,
        [ConversionFormat.XML]: 1_000_000,
        [ConversionFormat.YAML]: 1_000_000,
      },
    };

    it('applies the detected format limit, not a global one', async () => {
      const failure = run(
        serviceWith(tightCsv),
        'name,age\r\nAnn,30\r\nBob,41\r\n',
        ConversionFormat.JSON,
        'sample.csv',
      );

      await expect(failure).rejects.toMatchObject({ code: 'input_too_large' });
      await failure.catch((error: ConversionException) => {
        expect(error.getStatus()).toBe(413);
        expect((error.getResponse() as { message: string }).message).toContain(
          '8',
        );
      });
    });

    it('accepts the same byte count under a different source format', async () => {
      const json = JSON.stringify([{ name: 'Ann', age: '30' }]);

      await expect(
        run(serviceWith(tightCsv), json, ConversionFormat.CSV, 'sample.json'),
      ).resolves.toMatchObject({ sourceFormat: 'json' });
    });
  });

  describe('atomicity (FR-008)', () => {
    it('returns a buffer only on success, never alongside an error', async () => {
      // Every refusal path is a rejection, so there is no value a caller could
      // mistake for a partial result.
      const failures = [
        run(serviceWith(), '', ConversionFormat.JSON),
        run(serviceWith(), '<a><b></a>', ConversionFormat.JSON, 'x.xml'),
        run(
          serviceWith({ maxOutputBytes: 1 }),
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.JSON,
          'sample.csv',
        ),
      ];

      for (const failure of failures) {
        await expect(failure).rejects.toBeInstanceOf(ConversionException);
      }
    });

    it('produces a fully valid document on success', async () => {
      const result = await run(
        serviceWith(),
        FIXTURES[ConversionFormat.CSV],
        ConversionFormat.JSON,
        'sample.csv',
      );

      expect(() => {
        JSON.parse(result.buffer.toString('utf8'));
      }).not.toThrow();
    });
  });

  describe('concurrency bound (SC-008)', () => {
    // It bounds memory, not latency — Node runs one synchronous parse at a
    // time regardless. What it prevents is N uploads each holding a buffer
    // and its expanded model.
    it('runs every queued conversion, not just the first batch', async () => {
      const service = serviceWith({ maxConcurrent: 2 });

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          run(
            service,
            FIXTURES[ConversionFormat.CSV],
            ConversionFormat.JSON,
            'sample.csv',
          ),
        ),
      );

      expect(results).toHaveLength(10);
      for (const result of results) {
        expect(JSON.parse(result.buffer.toString('utf8'))).toHaveLength(2);
      }
    });

    it('releases its slot when a conversion fails', async () => {
      // Otherwise one bad document would permanently shrink the pool.
      const service = serviceWith({ maxConcurrent: 1 });

      await expect(
        run(service, '<a><b></a>', ConversionFormat.JSON, 'x.xml'),
      ).rejects.toBeInstanceOf(ConversionException);

      await expect(
        run(
          service,
          FIXTURES[ConversionFormat.CSV],
          ConversionFormat.JSON,
          'sample.csv',
        ),
      ).resolves.toBeDefined();
    });

    it('holds waiters to the same deadline', async () => {
      // Queueing behind other conversions must not buy a request extra time.
      const service = serviceWith({ maxConcurrent: 1, timeoutMs: 0 });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          run(
            service,
            FIXTURES[ConversionFormat.CSV],
            ConversionFormat.JSON,
            'sample.csv',
          ),
        ),
      );

      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
      }
    });
  });

  it('reports the bytes it actually received', async () => {
    const body = FIXTURES[ConversionFormat.CSV];
    const result = await run(
      serviceWith(),
      body,
      ConversionFormat.JSON,
      'sample.csv',
    );

    expect(result.inputSizeBytes).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('reports the target media type and extension', async () => {
    const result = await run(
      serviceWith(),
      FIXTURES[ConversionFormat.CSV],
      ConversionFormat.XML,
      'sample.csv',
    );

    expect(result.mediaType).toBe('application/xml');
    expect(result.extension).toBe('xml');
  });
});
