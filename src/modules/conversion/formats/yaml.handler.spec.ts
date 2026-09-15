import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import { YamlHandler } from './yaml.handler';

describe('YamlHandler', () => {
  const handler = new YamlHandler();

  const read = (input: string): Promise<DocumentNode> => handler.read(input);
  const write = async (node: DocumentNode): Promise<string> =>
    (await handler.write(node)).toString('utf8');

  it('declares its media type and extension', () => {
    expect(handler.format).toBe('yaml');
    expect(handler.mediaType).toBe('application/yaml');
    expect(handler.extension).toBe('yaml');
  });

  describe('YAML 1.2 core schema, not 1.1 (§6)', () => {
    // The whole reason `yaml` v2 is used instead of `js-yaml`: under 1.1 the
    // first four of these are booleans and `017` is fifteen.
    it.each([
      ['yes', 'yes'],
      ['no', 'no'],
      ['on', 'on'],
      ['off', 'off'],
      ['y', 'y'],
      ['n', 'n'],
    ])('reads %j as the string %j', async (input, expected) => {
      await expect(read(`v: ${input}`)).resolves.toEqual({ v: expected });
    });

    it('reads 017 as the integer seventeen, not as octal', async () => {
      await expect(read('v: 017')).resolves.toEqual({ v: 17 });
    });

    it('reads 0o17 as octal fifteen', async () => {
      await expect(read('v: 0o17')).resolves.toEqual({ v: 15 });
    });

    it('reads 0x1f as hexadecimal thirty-one', async () => {
      await expect(read('v: 0x1f')).resolves.toEqual({ v: 31 });
    });

    it.each([
      ['null', null],
      ['~', null],
      ['true', true],
      ['false', false],
      ['42', 42],
      ['1.5', 1.5],
      ['text', 'text'],
    ] as [string, DocumentNode][])(
      'maps the core scalar %j directly',
      async (input, expected) => {
        await expect(read(`v: ${input}`)).resolves.toEqual({ v: expected });
      },
    );

    it('reads a block mapping and a block sequence', async () => {
      await expect(read('a: 1\nb:\n  - x\n  - y\n')).resolves.toEqual({
        a: 1,
        b: ['x', 'y'],
      });
    });

    it('reads an empty document as null — a success, not an error (§7)', async () => {
      await expect(read('')).resolves.toBeNull();
      await expect(read('\n')).resolves.toBeNull();
    });
  });

  describe('refusals (§6)', () => {
    it.each([
      ['a non-core standard tag', "v: !!timestamp '2001-12-14'"],
      ['a language-specific tag', 'v: !!python/object:os.system {}'],
      ['an application tag', 'v: !Ref something'],
    ])('refuses %s', async (_label, input) => {
      await expect(read(input)).rejects.toBeInstanceOf(ConversionException);
    });

    it('refuses a second document rather than dropping it', async () => {
      // Converting only the first and saying nothing would lose data.
      try {
        await read('a: 1\n---\nb: 2\n');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe('parse_error');
      }
    });

    it('accepts a single document that opens with a marker', async () => {
      await expect(read('---\na: 1\n')).resolves.toEqual({ a: 1 });
    });

    it('refuses an alias bomb promptly', async () => {
      // A few hundred bytes that would expand to billions of nodes without
      // the cap. The assertion is that it refuses at all, and quickly.
      const bomb = [
        'a: &a ["x","x","x","x","x","x","x","x","x"]',
        'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
        'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
        'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
        'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
        'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
        'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
      ].join('\n');

      const started = Date.now();
      await expect(read(bomb)).rejects.toBeInstanceOf(ConversionException);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('refuses malformed YAML without quoting the input (SC-005)', async () => {
      const secret = 'SSN-123-45-6789';

      try {
        await read(`a: [1, 2\nb: ${secret}`);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('parse_error');
        expect(
          (exception.getResponse() as { message: string }).message,
        ).not.toContain(secret);
        expect(exception.toFailureReason()).not.toContain(secret);
      }
    });
  });

  describe('write (§6)', () => {
    it('uses block style with a two-space indent', async () => {
      expect(await write({ a: { b: 1 }, c: ['x', 'y'] })).toBe(
        'a:\n  b: 1\nc:\n  - x\n  - y\n',
      );
    });

    it('emits no anchors, even for a value repeated throughout', async () => {
      const shared = { n: 1 };
      const output = await write({ a: shared, b: shared } as DocumentNode);

      expect(output).not.toContain('&');
      expect(output).not.toContain('*');
    });

    it('quotes a string only where re-parsing needs it', async () => {
      const output = await write({ plain: 'text', tricky: 'yes', num: '42' });

      expect(output).toContain('plain: text');
      // "yes" and "42" must come back as strings, so they are quoted.
      await expect(read(output)).resolves.toEqual({
        plain: 'text',
        tricky: 'yes',
        num: '42',
      });
    });

    it('emits UTF-8 without a BOM', async () => {
      const buffer = await handler.write({ a: '🇵🇱 café' });

      expect(buffer[0]).not.toBe(0xef);
      expect(buffer.toString('utf8')).toContain('🇵🇱 café');
    });
  });

  describe('round trips', () => {
    it.each([
      ['a mapping', { a: 1, b: 'two', c: null, d: true }],
      ['a sequence', [1, 'two', null, false]],
      ['nesting', { a: { b: { c: ['x', { d: 1 }] } } }],
      ['strings that look like other types', { a: 'yes', b: '42', c: 'null' }],
      ['an empty mapping', {}],
      ['an empty sequence', []],
      ['Unicode', { a: '🇵🇱 café e\u0301 日本語' }],
    ] as [string, DocumentNode][])('round-trips %s', async (_label, node) => {
      await expect(read(await write(node))).resolves.toEqual(node);
    });
  });

  describe('sniff', () => {
    it.each(['a: 1', '- x', '---\na: 1', '  a: 1'])('accepts %j', (input) => {
      expect(handler.sniff(input, false)).toBe(true);
    });

    it.each(['<root/>', '', '# just a comment'])('rejects %j', (input) => {
      expect(handler.sniff(input, false)).toBe(false);
    });

    it('accepts a bare scalar only when the name says .yaml', () => {
      // A bare scalar is legal YAML but shows no block structure; accepting
      // every such document would make YAML a catch-all ahead of CSV.
      expect(handler.sniff('a,b', false)).toBe(false);
      expect(handler.sniff('a,b', true)).toBe(true);
    });

    it('is not conclusive, and runs after JSON', () => {
      expect(handler.sniffIsConclusive).toBe(false);
      expect(handler.detectionPriority).toBe(30);
    });
  });
});
