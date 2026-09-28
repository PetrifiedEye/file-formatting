import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import { JsonHandler } from './json.handler';
import { XML_TYPES_NAMESPACE, XmlHandler } from './xml.handler';

const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = `xmlns:ff="${XML_TYPES_NAMESPACE}"`;

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

    it('decodes the predefined entities and character references', async () => {
      await expect(
        read('<a v="x&#10;y&quot;">&lt;b&gt; &amp; &#65;&#x42;&apos;</a>'),
      ).resolves.toEqual({ a: { '@_v': 'x\ny"', '#text': "<b> & AB'" } });
    });

    it('decodes in one pass, so an escaped reference stays text', async () => {
      // `&amp;lt;` is the text `&lt;`, not `<`.
      await expect(read('<a>&amp;lt;&amp;#65;</a>')).resolves.toEqual({
        a: '&lt;&#65;',
      });
    });

    it('refuses a character reference to a non-character', async () => {
      await expect(read('<a>&#1;</a>')).rejects.toMatchObject({
        code: 'parse_error',
      });
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

    it('falls back to a marked <root> when the root has several keys (§4.2)', async () => {
      expect(await body({ a: '1', b: '2' })).toBe(
        `<root ${NS} ff:wrapped="true"><a>1</a><b>2</b></root>`,
      );
    });

    it('wraps a root array as <root><item>…</item></root> (§4.3)', async () => {
      expect(await body(['x', 'y'])).toBe(
        `<root ${NS} ff:type="array" ff:wrapped="true">` +
          '<item>x</item><item>y</item></root>',
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

    it('writes scalars as typed text and null as a typed empty element (§4.6)', async () => {
      expect(await body({ r: { n: 1, t: true, z: null, s: '' } })).toBe(
        `<r ${NS}><n ff:type="number">1</n><t ff:type="boolean">true</t>` +
          '<z ff:type="null"/><s/></r>',
      );
    });

    it('converts the worked example from the contract exactly (§4)', async () => {
      expect(await body({ items: [1, 2], meta: null })).toBe(
        `<root ${NS} ff:wrapped="true">` +
          '<items ff:type="number">1</items><items ff:type="number">2</items>' +
          '<meta ff:type="null"/></root>',
      );
    });

    it('writes a document of strings with no hints and no namespace', async () => {
      // CSV → XML is all strings: its output is exactly what it always was.
      expect(await body({ r: { a: '1', b: ['x', 'y'] } })).toBe(
        '<r><a>1</a><b>x</b><b>y</b></r>',
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

    /**
     * FINDING 2 of the code review. Attribute-value normalization (§3.3.3)
     * turns a literal TAB, LF or CR into a space on the way back in, and
     * end-of-line handling (§2.11) turns a CR in text into LF.
     */
    it('writes TAB, LF and CR in attributes, and CR in text, as references', async () => {
      const node = { r: { '@_note': 'a\tb\nc\rd', '#text': 'e\rf\ng' } };
      const xml = await body(node);

      expect(xml).toBe('<r note="a&#9;b&#10;c&#13;d">e&#13;f\ng</r>');
      await expect(read(xml)).resolves.toEqual(node);
    });

    /**
     * FINDING 2 of the code review: a NUL is legal in JSON and cannot exist in
     * XML 1.0 in any form — not even as `&#0;`. Emitting it produced a
     * document no conforming parser reads; it is refused instead (FR-009).
     */
    it.each([
      ['a NUL', 'x\u0000y'],
      ['a vertical tab', 'x\u000By'],
      ['U+FFFF', 'x\uFFFFy'],
      ['an unpaired surrogate', 'x\uD800y'],
    ])('refuses %s, which XML cannot carry', async (_label, text) => {
      await expect(write({ a: text })).rejects.toMatchObject({
        code: 'xml_unrepresentable',
      });
      await expect(write({ a: { '@_v': text } })).rejects.toMatchObject({
        code: 'xml_unrepresentable',
      });
    });

    it('refuses the NUL arriving from JSON, rather than emitting it', async () => {
      const model = await new JsonHandler().read('{"a":"x\\u0000y"}');

      await expect(handler.write(model)).rejects.toMatchObject({
        code: 'xml_unrepresentable',
      });
    });

    it('refuses a list or object where only text fits (§4.4)', async () => {
      await expect(write({ a: { '@_v': [1, 2] } })).rejects.toMatchObject({
        code: 'xml_unrepresentable',
      });
      await expect(write({ a: { '#text': { b: 1 } } })).rejects.toMatchObject({
        code: 'xml_unrepresentable',
      });
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
    it('reads a single element of someone else s XML as a scalar', async () => {
      // No hints: a one-item list and a scalar look the same.
      await expect(read('<r><item>pen</item></r>')).resolves.toEqual({
        r: { item: 'pen' },
      });
    });

    it('marks a one-item list it writes, so it comes back a list', async () => {
      const oneItem = { r: { item: ['pen'] } };

      expect(await body(oneItem)).toBe(
        `<r ${NS}><item ff:array="true">pen</item></r>`,
      );
      await expect(read(await body(oneItem))).resolves.toEqual(oneItem);
    });

    it('keeps a two-item list a list, with no hint needed', async () => {
      const twoItems = { r: { item: ['pen', 'ink'] } };

      expect(await body(twoItems)).toBe(
        '<r><item>pen</item><item>ink</item></r>',
      );
      await expect(read(await body(twoItems))).resolves.toEqual(twoItems);
    });
  });

  /** §3.8 / §4.9: what this handler writes, it reads back exactly. */
  describe('type hints', () => {
    it.each([
      [
        'numbers, booleans, null and leading zeros',
        { a: 1, b: true, c: null, d: '007', e: -2.5 },
      ],
      ['a one-item list', { r: { e: [1] } }],
      ['an empty list and an empty object', { r: { f: [], g: {} } }],
      ['lists of lists', { r: { i: [[1, 2], [3], []] } }],
      ['a list of objects', { r: { j: [{ k: 1 }] } }],
      ['a root list', [1, 'x', null, { y: false }]],
      ['a root scalar', 5],
      ['the empty string', { r: { s: '' } }],
      ['markup-like text', { r: { t: '<b> & "q"' } }],
    ])('round-trips %s', async (_label, node: DocumentNode) => {
      await expect(read(await body(node))).resolves.toEqual(node);
    });

    it('round-trips JSON through XML without losing a type', async () => {
      const json = new JsonHandler();
      const source =
        '{"a":1,"b":true,"c":null,"d":"007","e":[1],"f":[],"g":{},"h":[[1],[2,3]]}';

      const xml = await handler.write(await json.read(source));
      const back = await handler.read(xml.toString('utf8'));

      expect(back).toEqual(JSON.parse(source));
    });

    it('declares the namespace once, on the document element', async () => {
      const xml = await body({ r: { a: { b: 1 } } });

      expect(xml.match(/xmlns:ff=/g)).toHaveLength(1);
      expect(xml.startsWith(`<r ${NS}>`)).toBe(true);
    });

    it('ignores ff: attributes unless the document declares the namespace', async () => {
      // Someone else's `ff:` prefix — or a hand-written hint — is just an
      // attribute.
      await expect(read('<r><n ff:type="number">1</n></r>')).resolves.toEqual({
        r: { n: { '@_ff:type': 'number', '#text': '1' } },
      });
    });

    it('does not let a JSON key spoof a hint', async () => {
      // `ff:type` is not an XML Name here, so it is sanitized to `ff_type`.
      const xml = await body({ r: { '@_ff:type': 'null', '#text': 'x' } });

      expect(xml).toBe('<r ff_type="null">x</r>');
    });

    it.each([
      ['a number hint over non-numbers', '<n ff:type="number">abc</n>'],
      ['a boolean hint over other text', '<n ff:type="boolean">yes</n>'],
      ['a hint it never writes', '<n ff:type="date">2026</n>'],
    ])('refuses %s', async (_label, element) => {
      await expect(read(`<r ${NS}>${element}</r>`)).rejects.toMatchObject({
        code: 'parse_error',
      });
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
