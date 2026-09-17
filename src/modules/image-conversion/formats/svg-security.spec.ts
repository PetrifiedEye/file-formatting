import { ConversionException } from '@/modules/conversion/conversion.exception';

import { imageFixture } from './image-test-support';
import { validateSvg } from './svg-security';

function refusal(input: string | Buffer): ConversionException {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;

  try {
    validateSvg(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionException);
    return error as ConversionException;
  }

  throw new Error('expected a refusal');
}

const svg = (body: string, attributes = 'width="10" height="10"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;

describe('validateSvg', () => {
  describe('refuses active content', () => {
    it.each([
      ['a script element', 'scripted.svg'],
      ['an event handler attribute', 'onload.svg'],
      ['a javascript: href', 'javascript-href.svg'],
      ['a foreignObject', 'foreign-object.svg'],
    ])('%s', (_name, fixture) => {
      expect(refusal(imageFixture(fixture)).code).toBe('svg_active_content');
    });

    it.each([
      ['iframe', svg('<iframe/>')],
      ['embed', svg('<embed/>')],
      ['object', svg('<object/>')],
      ['handler', svg('<handler/>')],
      ['audio', svg('<audio/>')],
      ['video', svg('<video/>')],
    ])('a %s element', (_name, document) => {
      expect(refusal(document).code).toBe('svg_active_content');
    });

    it.each(['onclick', 'onmouseover', 'onbegin', 'onfocusin'])(
      'an %s attribute',
      (attribute) => {
        expect(refusal(svg(`<rect ${attribute}="alert(1)"/>`)).code).toBe(
          'svg_active_content',
        );
      },
    );
  });

  describe('refuses external references', () => {
    it.each([
      ['a remote image', 'remote-image.svg'],
      ['an @import stylesheet', 'import-stylesheet.svg'],
      ['a remote url() paint', 'remote-style-url.svg'],
      ['a relative path', 'relative-reference.svg'],
    ])('%s', (_name, fixture) => {
      expect(refusal(imageFixture(fixture)).code).toBe(
        'svg_external_reference',
      );
    });

    it.each([
      ['https', '<image href="https://example.test/a.png"/>'],
      ['file', '<image href="file:///etc/passwd"/>'],
      ['protocol-relative', '<image href="//example.test/a.png"/>'],
      ['a sibling path', '<image href="other.png"/>'],
      ['an absolute path', '<image href="/var/data/a.png"/>'],
      ['xlink:href', '<use xlink:href="http://example.test/a.svg#x"/>'],
      ['src', '<image src="http://example.test/a.png"/>'],
      ['a filter url()', '<rect filter="url(http://example.test/f.svg#b)"/>'],
      ['a mask url()', '<rect mask="url(//example.test/m.svg#m)"/>'],
      ['a clip-path url()', '<rect clip-path="url(./c.svg#c)"/>'],
      [
        'a marker url()',
        '<path marker-end="url(http://example.test/m.svg#m)"/>',
      ],
      [
        'a style attribute url()',
        '<rect style="fill:url(http://example.test/p.svg#g)"/>',
      ],
    ])('%s reference', (_name, body) => {
      expect(refusal(svg(body)).code).toBe('svg_external_reference');
    });

    it('a url() inside a style element', () => {
      expect(
        refusal(
          svg('<style>rect{fill:url(http://example.test/p.svg#g)}</style>'),
        ).code,
      ).toBe('svg_external_reference');
    });
  });

  describe('refuses entity declarations', () => {
    it.each([
      ['an XXE document', 'xxe.svg'],
      ['a billion-laughs document', 'billion-laughs.svg'],
    ])('%s', (_name, fixture) => {
      expect(refusal(imageFixture(fixture)).code).toBe('xml_doctype_forbidden');
    });

    /**
     * The point of refusing rather than bounding expansion: nothing is ever
     * expanded, so there is no budget to tune and no bomb to survive. The
     * document is refused before the parser sees it at all.
     */
    it('refuses a bare DOCTYPE with no entities', () => {
      expect(refusal(`<!DOCTYPE svg>${svg('<rect/>')}`).code).toBe(
        'xml_doctype_forbidden',
      );
    });

    it('returns quickly on a bomb rather than expanding it', () => {
      const started = Date.now();

      expect(refusal(imageFixture('billion-laughs.svg')).code).toBe(
        'xml_doctype_forbidden',
      );
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  describe('the parse-differential cases the raw scan exists for', () => {
    /**
     * Each of these is a construct a parser and a renderer might read
     * differently. The raw scan does not care how they parse — the literal
     * text is enough, which is the whole reason two independent checks exist.
     */
    it.each([
      ['a script inside CDATA', svg('<![CDATA[<script>alert(1)</script>]]>')],
      ['a namespaced script', svg('<svg:script>alert(1)</svg:script>')],
      ['an uppercase SCRIPT', svg('<SCRIPT>alert(1)</SCRIPT>')],
      ['a script in a comment', svg('<!-- <script>alert(1)</script> -->')],
      [
        'a handler behind odd whitespace',
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"\n\tonload\t=\t"alert(1)"><rect/></svg>',
      ],
      ['an entity-encoded javascript scheme', svg('<a href="javascript:x"/>')],
    ])('refuses %s', (_name, document) => {
      expect(() => validateSvg(Buffer.from(document))).toThrow(
        ConversionException,
      );
    });
  });

  describe('allows ordinary drawings', () => {
    it.each([
      ['a plain drawing', 'valid-declared.svg'],
      ['fragment references', 'valid-fragment-reference.svg'],
      ['an inline data: URI', 'valid-data-uri.svg'],
      ['a viewBox-only drawing', 'valid-viewbox-only.svg'],
    ])('%s', (_name, fixture) => {
      expect(() => validateSvg(imageFixture(fixture))).not.toThrow();
    });

    it.each([
      ['a fragment fill', '<rect fill="url(#grad)"/>'],
      ['a fragment href', '<use href="#p1"/>'],
      ['a data: image', '<image href="data:image/png;base64,AAAA"/>'],
      ['an empty href', '<use href=""/>'],
      ['a plain colour fill', '<rect fill="#ff0000"/>'],
      ['a gradient definition', '<defs><linearGradient id="g"/></defs>'],
    ])('%s', (_name, body) => {
      expect(() => validateSvg(Buffer.from(svg(body)))).not.toThrow();
    });
  });

  describe('what it returns', () => {
    /**
     * The validator refuses or passes the **original bytes**. Re-serializing
     * would recreate exactly the parse differential the two checks exist to
     * close: what was checked would no longer be what is rendered.
     */
    it('returns the original text unrewritten', () => {
      const original = imageFixture('valid-fragment-reference.svg');

      expect(validateSvg(original).text).toBe(original.toString('utf8'));
    });

    it('returns the root attributes for the sizing rule', () => {
      expect(
        validateSvg(imageFixture('valid-width-only.svg')).attributes,
      ).toMatchObject({ width: '200', viewBox: '0 0 300 150' });
    });

    it('strips a BOM without otherwise touching the document', () => {
      const body = svg('<rect/>');
      const withBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(body),
      ]);

      expect(validateSvg(withBom).text).toBe(body);
    });

    it('refuses input that is not valid UTF-8', () => {
      const broken = Buffer.concat([
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>',
        ),
        Buffer.from([0xff, 0xfe, 0xfd]),
        Buffer.from('</title></svg>'),
      ]);

      expect(refusal(broken).code).toBe('invalid_encoding');
    });

    it('refuses a document with no root svg element', () => {
      expect(refusal('<root><rect/></root>').code).toBe('svg_render_failed');
    });
  });
});
