import { ConversionFormat } from '../conversion.enums';
import { ConversionException } from '../conversion.exception';
import { CsvHandler } from './csv.handler';
import { DocumentNode } from './document-node';
import type { ConversionLimits } from './format-handler';

const limits: ConversionLimits = {
  maxInputBytes: {
    [ConversionFormat.CSV]: 1000,
    [ConversionFormat.JSON]: 1000,
    [ConversionFormat.XML]: 1000,
    [ConversionFormat.YAML]: 1000,
  },
  maxOutputBytes: 100_000,
  maxDepth: 64,
  maxNodes: 200_000,
  maxCsvColumns: 1024,
  timeoutMs: 10_000,
  maxConcurrent: 4,
};

describe('CsvHandler', () => {
  const handler = new CsvHandler();

  const read = (input: string): Promise<DocumentNode> =>
    handler.read(input, { limits });
  const write = async (
    node: DocumentNode,
    overrides: Partial<ConversionLimits> = {},
  ): Promise<string> =>
    (
      await handler.write(node, { limits: { ...limits, ...overrides } })
    ).toString('utf8');

  it('declares its media type and extension', () => {
    expect(handler.format).toBe('csv');
    expect(handler.mediaType).toBe('text/csv');
    expect(handler.extension).toBe('csv');
  });

  describe('CSV → model (§1)', () => {
    it('takes the first record as the header (§1.2)', async () => {
      await expect(read('name,age\r\nAnn,30')).resolves.toEqual([
        { name: 'Ann', age: '30' },
      ]);
    });

    it('refuses an empty header field (§1.2)', async () => {
      await expect(read('name,,age\r\nAnn,x,30')).rejects.toBeInstanceOf(
        ConversionException,
      );
    });

    it('refuses a repeated header field (§1.2)', async () => {
      try {
        await read('name,name\r\nAnn,Bob');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe(
          'csv_duplicate_header',
        );
        expect((error as ConversionException).getStatus()).toBe(400);
      }
    });

    it('keeps every value a string — no type inference (§1.4)', async () => {
      // Inferring would destroy 01234, 1.10, and long identifiers silently.
      await expect(
        read('zip,version,flag,id\r\n01234,1.10,true,9007199254740993'),
      ).resolves.toEqual([
        {
          zip: '01234',
          version: '1.10',
          flag: 'true',
          id: '9007199254740993',
        },
      ]);
    });

    it('reads an empty field as an empty string (§1.4)', async () => {
      await expect(read('a,b\r\n,x')).resolves.toEqual([{ a: '', b: 'x' }]);
    });

    it('fills a short record with empty strings, present not missing (§1.5)', async () => {
      const rows = (await read('name,age\r\nBob')) as Record<string, string>[];

      expect(rows).toEqual([{ name: 'Bob', age: '' }]);
      expect(Object.keys(rows[0])).toEqual(['name', 'age']);
    });

    it('puts surplus values under _extra_N from 1, in column order (§1.6)', async () => {
      await expect(read('name,age\r\nCid,41,extra,more')).resolves.toEqual([
        { name: 'Cid', age: '41', _extra_1: 'extra', _extra_2: 'more' },
      ]);
    });

    it('converts the ragged example from the contract exactly', async () => {
      const input = 'name,age\r\nAnn,30\r\nBob\r\nCid,41,extra';

      await expect(read(input)).resolves.toEqual([
        { name: 'Ann', age: '30' },
        { name: 'Bob', age: '' },
        { name: 'Cid', age: '41', _extra_1: 'extra' },
      ]);
    });

    it('yields an array of objects, one per data record (§1.7)', async () => {
      const rows = await read('a\r\n1\r\n2\r\n3');

      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(3);
    });

    it('yields [] for a header-only file — a success, not an error (§1.8)', async () => {
      await expect(read('name,age')).resolves.toEqual([]);
      await expect(read('name,age\r\n')).resolves.toEqual([]);
    });

    it('reads RFC 4180 quoting, including embedded delimiters and newlines', async () => {
      await expect(
        read('a,b\r\n"x,y","he said ""hi"""\r\n"line1\r\nline2",z'),
      ).resolves.toEqual([
        { a: 'x,y', b: 'he said "hi"' },
        { a: 'line1\r\nline2', b: 'z' },
      ]);
    });

    it('accepts LF-only records as well as CRLF', async () => {
      await expect(read('a,b\nx,y')).resolves.toEqual([{ a: 'x', b: 'y' }]);
    });

    it('refuses malformed quoting without quoting the input (SC-005)', async () => {
      const secret = 'SSN-123-45-6789';

      try {
        await read(`a,b\r\n"unterminated,${secret}`);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('parse_error');
        expect(
          (exception.getResponse() as { message: string }).message,
        ).not.toContain(secret);
      }
    });
  });

  describe('model → CSV (§2)', () => {
    it('writes one row per element for an array of objects (§2.1)', async () => {
      expect(await write([{ a: '1' }, { a: '2' }])).toBe('a\r\n1\r\n2\r\n');
    });

    it('writes exactly one row for a single object (§2.1)', async () => {
      expect(await write({ a: '1', b: '2' })).toBe('a,b\r\n1,2\r\n');
    });

    it('writes an array of scalars under a "value" column (§2.1)', async () => {
      expect(await write(['x', 'y'])).toBe('value\r\nx\r\ny\r\n');
    });

    it('writes a bare scalar under a "value" column (§2.1)', async () => {
      expect(await write('lonely')).toBe('value\r\nlonely\r\n');
    });

    it('writes the empty document for an empty array (§2.1)', async () => {
      // No rows means no paths, so there is no header to name.
      expect(await write([])).toBe('');
    });

    it('writes the empty document for an empty object', async () => {
      expect(await write({})).toBe('');
    });

    it('flattens nested values to path columns (§2.2)', async () => {
      expect(
        await write([{ id: 1, user: { name: 'Ann' }, tags: ['a', 'b'] }]),
      ).toBe('id,user.name,tags.0,tags.1\r\n1,Ann,a,b\r\n');
    });

    it('takes the header as the union of paths in first-appearance order (§2.3)', async () => {
      expect(await write([{ b: '1' }, { a: '2', b: '3' }])).toBe(
        'b,a\r\n1,\r\n3,2\r\n',
      );
    });

    it('writes an absent path and a null as the same empty field (§2.4)', async () => {
      // Documented loss: X → CSV cannot keep null apart from absent.
      expect(await write([{ a: null, b: '1' }, { b: '2' }])).toBe(
        'a,b\r\n,1\r\n,2\r\n',
      );
    });

    it('writes booleans and numbers as their JSON text (§2.4)', async () => {
      expect(await write([{ n: 1.5, t: true, f: false }])).toBe(
        'n,t,f\r\n1.5,true,false\r\n',
      );
    });

    it('quotes a field containing a quote, comma, CR, or LF (§2.5)', async () => {
      expect(await write([{ a: 'x,y' }])).toBe('a\r\n"x,y"\r\n');
      expect(await write([{ a: 'he said "hi"' }])).toBe(
        'a\r\n"he said ""hi"""\r\n',
      );
      expect(await write([{ a: 'line1\nline2' }])).toBe(
        'a\r\n"line1\nline2"\r\n',
      );
      expect(await write([{ a: 'line1\rline2' }])).toBe(
        'a\r\n"line1\rline2"\r\n',
      );
    });

    it('leaves a plain field unquoted (§2.5)', async () => {
      expect(await write([{ a: 'plain' }])).toBe('a\r\nplain\r\n');
    });

    it('separates records with CRLF (§2.5)', async () => {
      expect(await write([{ a: '1' }, { a: '2' }])).toMatch(/1\r\n2\r\n$/);
    });

    it('refuses rather than truncating a too-wide header (§2.6)', async () => {
      const wide = Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`c${i}`, 'x']),
      );

      try {
        await write([wide], { maxCsvColumns: 4 });
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('csv_too_many_columns');
        expect(
          (exception.getResponse() as { message: string }).message,
        ).toContain('4');
      }
    });

    it('accepts a header exactly at the column limit', async () => {
      const exact = Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [`c${i}`, 'x']),
      );

      await expect(
        handler.write(exact, { limits: { ...limits, maxCsvColumns: 4 } }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('escapes a literal dot in a key so the path stays reversible (§2.2)', async () => {
      expect(await write([{ 'a.b': '1' }])).toBe('a\\.b\r\n1\r\n');
    });
  });

  describe('round trips', () => {
    it('is exact for rectangular CSV (SC-001)', async () => {
      const original = 'name,age,city\r\nAnn,30,Rome\r\nBob,41,Oslo\r\n';

      expect(await write(await read(original))).toBe(original);
    });

    it('is exact for quoted and Unicode content', async () => {
      const original = 'a,b\r\n"x,y",🇵🇱 café\r\n';

      expect(await write(await read(original))).toBe(original);
    });

    it('keeps a header-only file empty in both directions', async () => {
      await expect(read('name,age')).resolves.toEqual([]);
      expect(await write([])).toBe('');
    });
  });

  describe('sniff', () => {
    it('accepts a non-empty first line', () => {
      expect(handler.sniff('a,b\r\n1,2', false)).toBe(true);
    });

    it('rejects input with no first line', () => {
      expect(handler.sniff('', false)).toBe(false);
      expect(handler.sniff('\r\nx', false)).toBe(false);
    });

    it('rejects a delimiter-free first line unless the name says .csv', () => {
      // Otherwise CSV is a catch-all and `unsupported_source_format` becomes
      // unreachable, because `read` accepts any single line as a header.
      expect(handler.sniff('just some prose', false)).toBe(false);
      expect(handler.sniff('just some prose', true)).toBe(true);
    });

    it('is not conclusive and runs last in the scan', () => {
      expect(handler.sniffIsConclusive).toBe(false);
      expect(handler.detectionPriority).toBe(40);
    });
  });
});
