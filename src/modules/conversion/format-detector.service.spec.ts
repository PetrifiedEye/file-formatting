import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { FormatDetectorService } from './format-detector.service';
import { FormatRegistryService } from './format-registry.service';
import { CsvHandler } from './formats/csv.handler';
import type { ConversionLimits } from './formats/format-handler';
import { JsonHandler } from './formats/json.handler';
import { XmlHandler } from './formats/xml.handler';
import { YamlHandler } from './formats/yaml.handler';

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

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('FormatDetectorService', () => {
  const registry = new FormatRegistryService(
    [new CsvHandler(), new JsonHandler(), new XmlHandler(), new YamlHandler()],
    limits,
  );
  const detector = new FormatDetectorService(registry);

  const detect = (input: string | Buffer, fileName?: string) =>
    detector.detect(
      detector.decode(
        Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8'),
      ),
      limits,
      fileName,
    );

  describe('encoding, before any format question (steps 1-2)', () => {
    it('refuses a zero-byte file', () => {
      try {
        detector.decode(Buffer.alloc(0));
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe('empty_file');
      }
    });

    it('refuses invalid UTF-8', () => {
      try {
        detector.decode(Buffer.from([0x61, 0xff, 0xfe, 0x62]));
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('invalid_encoding');
        expect(exception.getStatus()).toBe(400);
      }
    });

    it('consumes a BOM so it never reaches a handler', () => {
      const withBom = Buffer.concat([
        BOM,
        Buffer.from('name,age\r\nAnn,30', 'utf8'),
      ]);

      const decoded = detector.decode(withBom);

      expect(decoded.text.startsWith('name')).toBe(true);
      expect(decoded.text.charCodeAt(0)).not.toBe(0xfeff);
    });

    it('leaves Unicode content untouched', () => {
      const text = 'a\nPL café 日本語 🇵🇱';

      expect(detector.decode(Buffer.from(text, 'utf8')).text).toBe(text);
    });

    it('accepts a BOM-prefixed file as its real format', async () => {
      const withBom = Buffer.concat([
        BOM,
        Buffer.from('name,age\r\nAnn,30', 'utf8'),
      ]);

      await expect(detect(withBom)).resolves.toBe(ConversionFormat.CSV);
    });
  });

  describe('the ordered scan (steps 3-7)', () => {
    it('detects XML on a leading angle bracket', async () => {
      await expect(detect('<root><a>1</a></root>')).resolves.toBe(
        ConversionFormat.XML,
      );
      await expect(detect('<?xml version="1.0"?>\n<root/>')).resolves.toBe(
        ConversionFormat.XML,
      );
    });

    it('detects JSON on a leading brace or bracket that parses', async () => {
      await expect(detect('{"a":1}')).resolves.toBe(ConversionFormat.JSON);
      await expect(detect('[1,2,3]')).resolves.toBe(ConversionFormat.JSON);
    });

    it('detects YAML from a block mapping or sequence', async () => {
      await expect(detect('a: 1\nb: 2\n')).resolves.toBe(ConversionFormat.YAML);
      await expect(detect('- x\n- y\n')).resolves.toBe(ConversionFormat.YAML);
      await expect(detect('---\na: 1\n')).resolves.toBe(ConversionFormat.YAML);
    });

    it('detects CSV when nothing earlier claims the document', async () => {
      await expect(detect('name,age\r\nAnn,30\r\nBob,41')).resolves.toBe(
        ConversionFormat.CSV,
      );
    });

    it('refuses a blob that matches no format as unsupported', async () => {
      const blob = 'PNGIHDR';

      try {
        await detect(blob);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('unsupported_source_format');
        expect(exception.getStatus()).toBe(415);
      }
    });

    it('reports malformed XML as malformed, not as unsupported', async () => {
      // XML's sniff is conclusive, so a leading angle bracket settles the
      // format and the parse failure is reported as a parse failure.
      await expect(detect('<a><b></a>')).resolves.toBe(ConversionFormat.XML);
    });
  });

  describe('the extension tie-breaker (FR-003)', () => {
    it('resolves CSV-or-YAML ambiguity toward the extension', async () => {
      // `a,b` alone is a valid YAML scalar and a valid one-column CSV header.
      await expect(detect('a,b', 'data.csv')).resolves.toBe(
        ConversionFormat.CSV,
      );
      await expect(detect('a,b', 'data.yaml')).resolves.toBe(
        ConversionFormat.YAML,
      );
    });

    it('accepts .yml as well as .yaml', async () => {
      await expect(detect('a,b', 'data.yml')).resolves.toBe(
        ConversionFormat.YAML,
      );
    });

    it('lets content win when it disagrees with the extension', async () => {
      await expect(detect('{"a":1}', 'data.csv')).resolves.toBe(
        ConversionFormat.JSON,
      );
      await expect(detect('<root/>', 'data.json')).resolves.toBe(
        ConversionFormat.XML,
      );
      await expect(detect('name,age\r\nAnn,30', 'data.json')).resolves.toBe(
        ConversionFormat.CSV,
      );
    });

    it('ignores an extension naming no supported format', async () => {
      await expect(detect('{"a":1}', 'data.toml')).resolves.toBe(
        ConversionFormat.JSON,
      );
    });

    it('works with no file name at all', async () => {
      await expect(detect('{"a":1}')).resolves.toBe(ConversionFormat.JSON);
      await expect(detect('{"a":1}', 'noextension')).resolves.toBe(
        ConversionFormat.JSON,
      );
    });

    it('falls back to the scan when the hinted format does not parse', async () => {
      await expect(detect('<root><a/></root>', 'x.json')).resolves.toBe(
        ConversionFormat.XML,
      );
    });
  });

  describe('malformed, versus unidentifiable', () => {
    // The distinction the fixed scan order exists to make.
    it('reports a named format that rejected its own file as malformed', async () => {
      // Truncated JSON parses as nothing at all, but the name claimed JSON
      // and JSON is what refused it.
      try {
        await detect('{"a": 1,', 'data.json');
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect(exception.code).toBe('parse_error');
        expect(exception.getStatus()).toBe(400);
      }
    });

    it('reports a YAML file its own parser rejected as malformed', async () => {
      // No comma anywhere, so CSV does not sniff it either and YAML is the
      // only format that claimed — and rejected — the document.
      try {
        await detect("a: 'unterminated\nb: 2", 'data.yaml');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe('parse_error');
      }
    });

    it('still reports an unnamed unparseable document as unidentifiable', async () => {
      // Nothing claimed it, so "we could not tell what this is" is the honest
      // answer rather than a guess at which parser to blame.
      try {
        await detect('PNGIHDR', 'blob.png');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as ConversionException).code).toBe(
          'unsupported_source_format',
        );
      }
    });

    it('only decides what to report, never what was detected', async () => {
      // A `.csv` file holding JSON is still JSON: the rule above changes the
      // error reported when *nothing* parsed, and nothing else.
      await expect(detect('{"a":1}', 'data.csv')).resolves.toBe(
        ConversionFormat.JSON,
      );
      await expect(detect('<root/>', 'data.json')).resolves.toBe(
        ConversionFormat.XML,
      );
    });

    it('lets the extension settle a document that is legal as two formats', async () => {
      // `name,age\r\nAnn,30` is a two-record CSV and also a single YAML plain
      // scalar. Named `.yaml`, the name decides — the same tie-breaker that
      // makes `a,b` work, applied to a longer document.
      await expect(detect('name,age\r\nAnn,30', 'data.yaml')).resolves.toBe(
        ConversionFormat.YAML,
      );
      await expect(detect('name,age\r\nAnn,30', 'data.csv')).resolves.toBe(
        ConversionFormat.CSV,
      );
      await expect(detect('name,age\r\nAnn,30')).resolves.toBe(
        ConversionFormat.CSV,
      );
    });
  });

  describe('every source format round-trips through detection', () => {
    it.each([
      ['csv', 'name,age\r\nAnn,30', ConversionFormat.CSV],
      ['json', '[{"name":"Ann"}]', ConversionFormat.JSON],
      ['xml', '<rows><row><name>Ann</name></row></rows>', ConversionFormat.XML],
      ['yaml', '- name: Ann\n  age: "30"\n', ConversionFormat.YAML],
    ])('detects a well-formed %s document', async (_label, input, expected) => {
      await expect(detect(input)).resolves.toBe(expected);
    });
  });
});
