import { ConversionFormat } from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { FormatRegistryService } from './format-registry.service';
import type { ConversionLimits, FormatHandler } from './formats/format-handler';

function stubHandler(format: ConversionFormat): FormatHandler {
  return {
    format,
    mediaType: `application/${format}`,
    extension: format,
    detectionPriority: 10,
    sniffIsConclusive: false,
    sniff: () => false,
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(Buffer.alloc(0)),
  };
}

function limitsFor(
  overrides: Partial<Record<ConversionFormat, number>> = {},
): ConversionLimits {
  return {
    maxInputBytes: {
      [ConversionFormat.CSV]: 1000,
      [ConversionFormat.JSON]: 2000,
      [ConversionFormat.XML]: 3000,
      [ConversionFormat.YAML]: 4000,
      ...overrides,
    },
    maxOutputBytes: 50_000,
    maxDepth: 64,
    maxNodes: 200_000,
    maxCsvColumns: 1024,
    timeoutMs: 10_000,
    maxConcurrent: 4,
  };
}

function registryOf(...formats: ConversionFormat[]): FormatRegistryService {
  return new FormatRegistryService(formats.map(stubHandler), limitsFor());
}

describe('FormatRegistryService', () => {
  describe('derived directions', () => {
    // The point of these three: the direction list is computed from what is
    // registered, so it cannot drift from what conversion accepts (FR-030).
    it('yields two directions for two handlers', () => {
      const registry = registryOf(ConversionFormat.CSV, ConversionFormat.JSON);

      expect(registry.directions()).toEqual([
        { source: ConversionFormat.CSV, target: ConversionFormat.JSON },
        { source: ConversionFormat.JSON, target: ConversionFormat.CSV },
      ]);
    });

    it('yields six directions for three handlers', () => {
      const registry = registryOf(
        ConversionFormat.CSV,
        ConversionFormat.JSON,
        ConversionFormat.XML,
      );

      expect(registry.directions()).toHaveLength(6);
    });

    it('yields the twelve directions the spec requires for four handlers', () => {
      const registry = registryOf(
        ConversionFormat.CSV,
        ConversionFormat.JSON,
        ConversionFormat.XML,
        ConversionFormat.YAML,
      );

      expect(registry.directions()).toHaveLength(12);
    });

    it('yields nothing for a single handler', () => {
      expect(registryOf(ConversionFormat.CSV).directions()).toEqual([]);
    });

    it('never advertises a direction onto itself', () => {
      const registry = registryOf(
        ConversionFormat.CSV,
        ConversionFormat.JSON,
        ConversionFormat.XML,
        ConversionFormat.YAML,
      );

      for (const direction of registry.directions()) {
        expect(direction.source).not.toBe(direction.target);
      }
    });

    it('orders sources and targets alphabetically', () => {
      const registry = registryOf(
        ConversionFormat.YAML,
        ConversionFormat.CSV,
        ConversionFormat.XML,
        ConversionFormat.JSON,
      );

      expect(registry.formats()).toEqual(['csv', 'json', 'xml', 'yaml']);
      expect(registry.describe().map((entry) => entry.source)).toEqual([
        'csv',
        'json',
        'xml',
        'yaml',
      ]);
      expect(registry.describe()[0].targets).toEqual(['json', 'xml', 'yaml']);
    });
  });

  describe('supports', () => {
    const registry = registryOf(ConversionFormat.CSV, ConversionFormat.JSON);

    it('accepts a registered pair', () => {
      expect(
        registry.supports(ConversionFormat.CSV, ConversionFormat.JSON),
      ).toBe(true);
    });

    it('refuses a self-direction', () => {
      expect(
        registry.supports(ConversionFormat.CSV, ConversionFormat.CSV),
      ).toBe(false);
    });

    it('refuses a format that is not registered', () => {
      expect(
        registry.supports(ConversionFormat.CSV, ConversionFormat.YAML),
      ).toBe(false);
    });

    it('agrees exactly with the advertised directions', () => {
      const full = registryOf(
        ConversionFormat.CSV,
        ConversionFormat.JSON,
        ConversionFormat.XML,
        ConversionFormat.YAML,
      );
      const advertised = new Set(
        full.directions().map(({ source, target }) => `${source}->${target}`),
      );
      const all = Object.values(ConversionFormat);

      for (const source of all) {
        for (const target of all) {
          expect(full.supports(source, target)).toBe(
            advertised.has(`${source}->${target}`),
          );
        }
      }
    });
  });

  describe('limits', () => {
    it('reports each source format its own configured limit', () => {
      const registry = registryOf(
        ConversionFormat.CSV,
        ConversionFormat.JSON,
        ConversionFormat.XML,
        ConversionFormat.YAML,
      );

      expect(registry.describe().map((entry) => entry.maxInputBytes)).toEqual([
        1000, 2000, 3000, 4000,
      ]);
    });

    it('takes the multipart ceiling from the largest registered limit', () => {
      expect(
        registryOf(
          ConversionFormat.CSV,
          ConversionFormat.JSON,
        ).maxConfiguredInputBytes(),
      ).toBe(2000);
    });

    it('falls back to the smallest configured limit for an unconfigured format', () => {
      // A newly registered format is conservative until an administrator
      // configures it, rather than unbounded.
      const exotic = 'toml' as ConversionFormat;
      const registry = new FormatRegistryService(
        [stubHandler(ConversionFormat.CSV), stubHandler(exotic)],
        limitsFor(),
      );

      expect(registry.maxInputBytesFor(exotic)).toBe(1000);
    });
  });

  describe('handler lookup', () => {
    const registry = registryOf(ConversionFormat.CSV, ConversionFormat.JSON);

    it('finds a registered handler', () => {
      expect(registry.handlerFor(ConversionFormat.CSV)?.format).toBe('csv');
    });

    it('returns undefined for an unregistered format', () => {
      expect(registry.handlerFor(ConversionFormat.YAML)).toBeUndefined();
    });

    it('refuses an unregistered target with the documented 415', () => {
      try {
        registry.requireHandler(
          ConversionFormat.YAML,
          'unsupported_target_format',
        );
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionException);
        expect((error as ConversionException).getStatus()).toBe(415);
        expect((error as ConversionException).code).toBe(
          'unsupported_target_format',
        );
      }
    });
  });

  it('orders detection by the priority each handler declares', () => {
    const low = { ...stubHandler(ConversionFormat.CSV), detectionPriority: 40 };
    const high = {
      ...stubHandler(ConversionFormat.XML),
      detectionPriority: 10,
    };
    const registry = new FormatRegistryService([low, high], limitsFor());

    expect(registry.detectionOrder().map((handler) => handler.format)).toEqual([
      'xml',
      'csv',
    ]);
  });
});
