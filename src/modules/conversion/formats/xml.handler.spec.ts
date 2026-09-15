import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import { XmlHandler } from './xml.handler';

const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

describe('XmlHandler', () => {
  const handler = new XmlHandler();

  const read = (input: string): Promise<DocumentNode> => handler.read(input);
  const write = async (node: DocumentNode): Promise<string> =>
    (await handler.write(node)).toString('utf8').trim();
  const body = async (node: DocumentNode): Promise<string> =>
    (await write(node)).slice(PROLOG.length).trim();

  it('declares its media type and extension', () => {
    expect(handler.format).toBe('xml');
    expect(handler.mediaType).toBe('application/xml');
    expect(handler.extension).toBe('xml');
  });

  describe('XML → model (§3)', () => {
    it('refuses a DOCTYPE declaration outright (§3.1, FR-018)', async () => {
      const xxe =
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>';

      try {
        await read(xxe);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('xml_doctype_forbidden');
        expect(exception.getStatus()).toBe(400);
        // SC-007: the referenced path must not come back in the message.
        expect(
          (exception.getResponse() as { message: string }).message,
        ).not.toContain('passwd');
      }
    });

    it('refuses a DOCTYPE with no entity declaration too', async () => {
      await expect(
        read('<!DOCTYPE html><html><body>x</body></html>'),
      ).rejects.toBeInstanceOf(ConversionException);
    });

    it('discards comments, processing instructions, and the declaration (§3.2)', async () => {
      await expect(
        read(`${PROLOG}<!-- note --><?pi data?><a>x</a>`),
      ).resolves.toEqual({ a: 'x' });
    });

    it('makes the document element the single root key (§3.3)', async () => {
      await expect(read('<order><a>1</a></order>')).resolves.toEqual({
        order: { a: '1' },
      });
    });

    it('collapses an element with no attributes or children to its text (§3.4)', async () => {
      await expect(read('<a>text</a>')).resolves.toEqual({ a: 'text' });
    });

    it('puts attributes under @_name and text under #text (§3.4)', async () => {
      await expect(read('<a id="7">text</a>')).resolves.toEqual({
        a: { '@_id': '7', '#text': 'text' },
      });
    });

    it('makes repeated siblings an array in document order (§3.5)', async () => {
      await expect(
        read('<r><item>pen</item><item>ink</item></r>'),
      ).resolves.toEqual({ r: { item: ['pen', 'ink'] } });
    });

    it('does NOT wrap a name appearing once in an array (§3.5)', async () => {
      // The asymmetry is deliberate: a one-item list in XML is
      // indistinguishable from a scalar.
      await expect(read('<r><item>pen</item></r>')).resolves.toEqual({
        r: { item: 'pen' },
      });
    });

    it('converts the worked example from the contract exactly', async () => {
      await expect(
        read(
          '<order id="7"><item>pen</item><item>ink</item><note>urgent</note></order>',
        ),
      ).resolves.toEqual({
        order: { '@_id': '7', item: ['pen', 'ink'], note: 'urgent' },
      });
    });

    it('reads an empty element as "" (§3.6)', async () => {
      await expect(read('<r><a/><b></b></r>')).resolves.toEqual({
        r: { a: '', b: '' },
      });
    });

    it('keeps leaf values as strings — no type inference (§3.7)', async () => {
      await expect(
        read('<r><n>1</n><t>true</t><z>01234</z></r>'),
      ).resolves.toEqual({ r: { n: '1', t: 'true', z: '01234' } });
    });

    it('does not expand a declared internal entity', async () => {
      // Belt and braces behind the DOCTYPE refusal: processEntities is off.
      await expect(read('<a>&amp;lt;</a>')).resolves.toEqual({ a: '&amp;lt;' });
    });

    it('refuses malformed markup without quoting it (SC-005)', async () => {
      const secret = 'SSN-123-45-6789';

      try {
        await read(`<a><b>${secret}</a>`);
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

  describe('model → XML (§4)', () => {
    it('emits the prolog (§4.1)', async () => {
      expect((await write({ a: 'x' })).startsWith(PROLOG)).toBe(true);
    });

    it('uses a single valid-Name root key as the document element (§4.2)', async () => {
      expect(await body({ order: { a: '1' } })).toBe('<order><a>1</a></order>');
    });

    it('falls back to <root> when the root has several keys (§4.2)', async () => {
      expect(await body({ a: '1', b: '2' })).toBe(
        '<root><a>1</a><b>2</b></root>',
      );
    });

    it('wraps a root array as <root><item>…</item></root> (§4.3)', async () => {
      expect(await body(['x', 'y'])).toBe(
        '<root><item>x</item><item>y</item></root>',
      );
    });

    it('writes @_ keys as attributes and #text as text (§4.4)', async () => {
      expect(await body({ a: { '@_id': '7', '#text': 'text' } })).toBe(
        '<a id="7">text</a>',
      );
    });

    it('emits an array as repeated sibling elements (§4.5)', async () => {
      expect(await body({ r: { item: ['pen', 'ink'] } })).toBe(
        '<r><item>pen</item><item>ink</item></r>',
      );
    });

    it('writes scalars as text and null as an empty element (§4.6)', async () => {
      expect(await body({ r: { n: 1, t: true, z: null } })).toBe(
        '<r><n>1</n><t>true</t><z/></r>',
      );
    });

    it('converts the worked example from the contract exactly (§4)', async () => {
      expect(await body({ items: [1, 2], meta: null })).toBe(
        '<root><items>1</items><items>2</items><meta/></root>',
      );
    });

    it('escapes &, < and > in text (§4.7)', async () => {
      expect(await body({ a: 'x & y < z > w' })).toBe(
        '<a>x &amp; y &lt; z &gt; w</a>',
      );
    });

    it('escapes &, <, > and " in attribute values (§4.7)', async () => {
      expect(await body({ a: { '@_v': 'x&"<>', '#text': 't' } })).toBe(
        '<a v="x&amp;&quot;&lt;&gt;">t</a>',
      );
    });

    it('sanitizes a key that is not a valid XML Name (§4.8)', async () => {
      expect(await body({ r: { 'user name': 'Ann' } })).toBe(
        '<r><user_name>Ann</user_name></r>',
      );
    });

    it('prefixes a key that cannot start a Name (§4.8)', async () => {
      expect(await body({ r: { '1st': 'x' } })).toBe('<r><_1st>x</_1st></r>');
    });

    it('keeps a hyphen, which is legal in an XML Name (§4.8)', async () => {
      // The mapping-rules illustration treats `-` as invalid; it is not, and
      // rewriting `user-name` would change data that needed no changing.
      expect(await body({ r: { 'user-name': 'Ann' } })).toBe(
        '<r><user-name>Ann</user-name></r>',
      );
    });

    it('refuses rather than dropping a field when sanitizing collides (§4.8)', async () => {
      // `user name` and `user+name` both become `user_name`; writing one over
      // the other would lose a field silently.
      const collision = body({ r: { 'user name': 'Ann', 'user+name': 'Bob' } });

      await expect(collision).rejects.toBeInstanceOf(ConversionException);
      await expect(collision).rejects.toMatchObject({
        code: 'xml_name_collision',
      });
      await collision.catch((error: ConversionException) => {
        expect(error.getStatus()).toBe(400);
      });
    });

    it('emits UTF-8 without a BOM', async () => {
      const buffer = await handler.write({ a: '🇵🇱 café' });

      expect(buffer[0]).not.toBe(0xef);
      expect(buffer.toString('utf8')).toContain('🇵🇱 café');
    });
  });

  describe('the single-vs-repeated asymmetry, asserted in both directions', () => {
    it('loses the one-item list on the way out and back', async () => {
      const oneItem = { r: { item: ['pen'] } };

      // Written as a single element…
      expect(await body(oneItem)).toBe('<r><item>pen</item></r>');
      // …and read back as a scalar. Documented, not a bug.
      await expect(read(await body(oneItem))).resolves.toEqual({
        r: { item: 'pen' },
      });
    });

    it('keeps a two-item list a list', async () => {
      const twoItems = { r: { item: ['pen', 'ink'] } };

      await expect(read(await body(twoItems))).resolves.toEqual(twoItems);
    });
  });

  describe('sniff', () => {
    it('accepts a leading <', () => {
      expect(handler.sniff('  <root/>')).toBe(true);
      expect(handler.sniff(`${PROLOG}<a/>`)).toBe(true);
    });

    it('rejects anything else', () => {
      expect(handler.sniff('a,b')).toBe(false);
      expect(handler.sniff('{"a":1}')).toBe(false);
    });

    it('is conclusive and runs first in the scan', () => {
      // So malformed XML is reported as malformed, not as "unsupported".
      expect(handler.sniffIsConclusive).toBe(true);
      expect(handler.detectionPriority).toBe(10);
    });
  });
});
