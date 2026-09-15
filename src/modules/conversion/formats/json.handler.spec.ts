import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import { JsonHandler } from './json.handler';

describe('JsonHandler', () => {
  const handler = new JsonHandler();

  const read = (input: string): Promise<DocumentNode> => handler.read(input);
  const write = async (node: DocumentNode): Promise<string> =>
    (await handler.write(node)).toString('utf8');

  it('declares its media type and extension', () => {
    expect(handler.format).toBe('json');
    expect(handler.mediaType).toBe('application/json');
    expect(handler.extension).toBe('json');
  });

  describe('read — identity onto the model (rule 5)', () => {
    it.each([
      ['an object', '{"a":1}', { a: 1 }],
      ['an array', '[1,2]', [1, 2]],
      ['a nested structure', '{"a":{"b":[1,null]}}', { a: { b: [1, null] } }],
      ['an empty object', '{}', {}],
      ['an empty array', '[]', []],
      ['a bare scalar', '"text"', 'text'],
      ['null', 'null', null],
      ['a number', '1.5', 1.5],
      ['a boolean', 'true', true],
    ] as [string, string, DocumentNode][])(
      'reads %s',
      async (_label, input, expected) => {
        await expect(read(input)).resolves.toEqual(expected);
      },
    );

    it('resolves duplicate keys last-wins', () => {
      return expect(read('{"a":1,"a":2}')).resolves.toEqual({ a: 2 });
    });

    it('preserves Unicode content byte for byte', async () => {
      const value = 'Ĺukasz 🇵🇱 café é 日本語';
      await expect(read(JSON.stringify({ value }))).resolves.toEqual({ value });
    });
  });

  describe('write — identity off the model (rule 5)', () => {
    it('indents with two spaces and ends with a newline', async () => {
      expect(await write({ a: 1, b: [2] })).toBe(
        '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n',
      );
    });

    it('emits UTF-8 without a BOM', async () => {
      const buffer = await handler.write({ a: 'é' });

      expect(buffer[0]).not.toBe(0xef);
      expect(buffer.toString('utf8')).toContain('é');
    });

    it('round-trips every model shape', async () => {
      const nodes: DocumentNode[] = [
        { a: 1, b: 'two', c: null, d: true },
        [1, 'two', null, false],
        {},
        [],
        'scalar',
        0,
      ];

      for (const node of nodes) {
        await expect(read(await write(node))).resolves.toEqual(node);
      }
    });
  });

  describe('sniff', () => {
    it.each(['{"a":1}', '[1]', '  \n {"a":1}'])('accepts %j', (input) => {
      expect(handler.sniff(input)).toBe(true);
    });

    it.each(['a,b', 'a: 1', '<root/>', ''])('rejects %j', (input) => {
      expect(handler.sniff(input)).toBe(false);
    });

    it('is not conclusive — malformed JSON must fall through the scan', () => {
      expect(handler.sniffIsConclusive).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('refuses with the fixed parse_error code', async () => {
      await expect(read('{"a":')).rejects.toBeInstanceOf(ConversionException);

      try {
        await read('{"a":');
      } catch (error) {
        expect((error as ConversionException).code).toBe('parse_error');
        expect((error as ConversionException).getStatus()).toBe(400);
      }
    });

    it('reports a line and column, never the text at them (SC-005)', async () => {
      // V8's own message quotes the offending token; only the position of the
      // failure survives translation.
      const secret = 'SSN-123-45-6789';

      try {
        await read(`{\n  "a": 1,\n  "b": ${secret}\n}`);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        const body = exception.getResponse() as { message: string };

        expect(body.message).not.toContain(secret);
        expect(body.message).not.toContain('123-45-6789');
        expect(body.message).toMatch(/at line \d+, column \d+/);
        expect(exception.toFailureReason()).not.toContain(secret);
      }
    });

    it('still refuses cleanly when the message carries no position', async () => {
      try {
        await read('');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe('parse_error');
      }
    });
  });
});
