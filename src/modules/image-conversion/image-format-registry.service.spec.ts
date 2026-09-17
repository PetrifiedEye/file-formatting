import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import {
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  DETECTION_PRIORITY,
} from './image-conversion.constants';
import { ImageFormatRegistryService } from './image-format-registry.service';
import type {
  ImageConversionLimits,
  ImageFormatHandler,
} from './formats/image-format-handler';

const LIMITS = {
  maxInputBytes: {
    [ImageFormat.PNG]: 10485760,
    [ImageFormat.JPEG]: 10485760,
    [ImageFormat.SVG]: 2097152,
  },
  maxOutputWidth: 8192,
  maxOutputHeight: 8192,
  maxPixels: 16000000,
  maxOutputBytes: 20971520,
  backgroundColor: '#ffffff',
  jpegQuality: 85,
  timeoutMs: 30000,
  maxConcurrent: 2,
  svgFontDir: null,
} satisfies ImageConversionLimits;

/**
 * A handler stub declaring only its capabilities. The registry reads nothing
 * else, which is the property under test.
 */
function handler(
  format: ImageFormat,
  capabilities: { decode?: boolean; encode?: boolean },
): ImageFormatHandler {
  return {
    format,
    mediaType: IMAGE_MEDIA_TYPES[format],
    extension: IMAGE_EXTENSIONS[format],
    detectionPriority: DETECTION_PRIORITY[format],
    sniffIsConclusive: true,
    sniff: jest.fn(() => false),
    ...(capabilities.decode ? { decode: jest.fn() } : {}),
    ...(capabilities.encode ? { encode: jest.fn() } : {}),
  } as ImageFormatHandler;
}

/** The three real handlers, by capability: PNG and JPEG both, SVG decode only. */
function registry(
  handlers: ImageFormatHandler[] = [
    handler(ImageFormat.PNG, { decode: true, encode: true }),
    handler(ImageFormat.JPEG, { decode: true, encode: true }),
    handler(ImageFormat.SVG, { decode: true }),
  ],
): ImageFormatRegistryService {
  return new ImageFormatRegistryService(handlers, LIMITS);
}

describe('ImageFormatRegistryService', () => {
  it('computes exactly the four directions FR-002 requires', () => {
    expect(registry().directions()).toEqual([
      { source: 'jpeg', target: 'png' },
      { source: 'png', target: 'jpeg' },
      { source: 'svg', target: 'jpeg' },
      { source: 'svg', target: 'png' },
    ]);
  });

  /**
   * The structural half of FR-003. `svg` is absent because the SVG handler
   * implements no `encode` — not because anything filters it out — so
   * vectorisation is unrepresentable rather than forbidden.
   */
  it('never offers svg as a target', () => {
    const service = registry();

    expect(service.targets()).not.toContain(ImageFormat.SVG);

    for (const { target } of service.directions()) {
      expect(target).not.toBe(ImageFormat.SVG);
    }

    for (const descriptor of service.describe()) {
      expect(descriptor.targets).not.toContain(ImageFormat.SVG);
    }
  });

  it('still offers svg as a source', () => {
    expect(registry().sources()).toContain(ImageFormat.SVG);
  });

  it('orders sources and targets alphabetically', () => {
    const service = registry();

    expect(service.sources()).toEqual(['jpeg', 'png', 'svg']);
    expect(service.describe().map((entry) => entry.source)).toEqual([
      'jpeg',
      'png',
      'svg',
    ]);
    expect(
      service.describe().find((entry) => entry.source === ImageFormat.SVG)
        ?.targets,
    ).toEqual(['jpeg', 'png']);
  });

  /**
   * FR-013 / SC-010: discovery and enforcement are one computation, so the two
   * cannot disagree. Asserted directly rather than by comparing two lists.
   */
  it('answers discovery and enforcement from the same computation', () => {
    const service = registry();
    const advertised = service
      .describe()
      .flatMap((entry) =>
        entry.targets.map((target) => `${entry.source}->${target}`),
      )
      .sort();

    const accepted = Object.values(ImageFormat)
      .flatMap((source) =>
        Object.values(ImageFormat).map((target) => ({ source, target })),
      )
      .filter(({ source, target }) => service.supports(source, target))
      .map(({ source, target }) => `${source}->${target}`)
      .sort();

    expect(advertised).toEqual(accepted);
    expect(advertised).toEqual([
      'jpeg->png',
      'png->jpeg',
      'svg->jpeg',
      'svg->png',
    ]);
  });

  it('describes each source with its media type, extension, and limit', () => {
    expect(registry().describe()).toEqual([
      {
        source: 'jpeg',
        mediaType: 'image/jpeg',
        extension: 'jpg',
        maxInputBytes: 10485760,
        targets: ['png'],
      },
      {
        source: 'png',
        mediaType: 'image/png',
        extension: 'png',
        maxInputBytes: 10485760,
        targets: ['jpeg'],
      },
      {
        source: 'svg',
        mediaType: 'image/svg+xml',
        extension: 'svg',
        maxInputBytes: 2097152,
        targets: ['jpeg', 'png'],
      },
    ]);
  });

  it('refuses a source that cannot decode', () => {
    const service = registry([
      handler(ImageFormat.PNG, { encode: true }),
      handler(ImageFormat.JPEG, { decode: true, encode: true }),
    ]);

    expect(() => service.requireDecoder(ImageFormat.PNG)).toThrow(
      ConversionException,
    );
    expect(() => service.requireDecoder(ImageFormat.SVG)).toThrow(
      expect.objectContaining({ code: 'unsupported_source_format' }) as Error,
    );
  });

  /**
   * A registered format with no encoder is not "unknown" — it is one this
   * service will never produce, which is the distinct refusal US5.4 asks for.
   */
  it('distinguishes an unknown target from an unproduceable one', () => {
    const service = registry();

    expect(() => service.requireEncoder(ImageFormat.SVG)).toThrow(
      expect.objectContaining({
        code: 'image_vectorisation_unsupported',
      }) as Error,
    );

    const withoutJpeg = registry([
      handler(ImageFormat.PNG, { decode: true, encode: true }),
    ]);

    expect(() => withoutJpeg.requireEncoder(ImageFormat.JPEG)).toThrow(
      expect.objectContaining({ code: 'unsupported_target_format' }) as Error,
    );
  });

  it('never reports a self-pair as supported', () => {
    for (const format of Object.values(ImageFormat)) {
      expect(registry().supports(format, format)).toBe(false);
    }
  });

  it('applies the detected format s own byte limit', () => {
    const service = registry();

    expect(service.maxInputBytesFor(ImageFormat.PNG)).toBe(10485760);
    expect(service.maxInputBytesFor(ImageFormat.SVG)).toBe(2097152);
    expect(service.maxConfiguredInputBytes()).toBe(10485760);
  });

  /**
   * SC-014, the worked "adding a format" case. Registering one more handler
   * that implements both capabilities widens the direction set by itself — no
   * existing handler is consulted, changed, or even asked whether it minds.
   */
  describe('adding a format', () => {
    const webp = {
      format: 'webp' as ImageFormat,
      mediaType: 'image/webp',
      extension: 'webp',
      detectionPriority: 40,
      sniffIsConclusive: true,
      sniff: () => false,
      decode: jest.fn(),
      encode: jest.fn(),
    } as unknown as ImageFormatHandler;

    it('widens the direction set with no edit anywhere else', () => {
      const before = registry().directions();
      const existing = [
        handler(ImageFormat.PNG, { decode: true, encode: true }),
        handler(ImageFormat.JPEG, { decode: true, encode: true }),
        handler(ImageFormat.SVG, { decode: true }),
      ];
      const after = new ImageFormatRegistryService(
        [...existing, webp],
        LIMITS,
      ).directions();

      const added = after
        .filter(
          (direction) =>
            !before.some(
              (old) =>
                old.source === direction.source &&
                old.target === direction.target,
            ),
        )
        .map(({ source, target }) => `${source}->${target}`);

      expect(added.sort()).toEqual([
        'jpeg->webp',
        'png->webp',
        'svg->webp',
        'webp->jpeg',
        'webp->png',
      ]);
    });

    it('consults no existing handler to do it', () => {
      const existing = [
        handler(ImageFormat.PNG, { decode: true, encode: true }),
        handler(ImageFormat.JPEG, { decode: true, encode: true }),
        handler(ImageFormat.SVG, { decode: true }),
      ];
      const service = new ImageFormatRegistryService(
        [...existing, webp],
        LIMITS,
      );

      service.directions();
      service.describe();

      for (const entry of existing) {
        for (const capability of ['decode', 'encode', 'sniff'] as const) {
          const method = entry[capability] as jest.Mock | undefined;

          expect(method?.mock.calls ?? []).toEqual([]);
        }
      }
    });

    /**
     * A format with no configured limit is conservative rather than
     * unbounded — the safe direction for this story to fail in.
     */
    it('gives an unconfigured format the smallest configured limit', () => {
      const service = new ImageFormatRegistryService(
        [handler(ImageFormat.PNG, { decode: true, encode: true }), webp],
        LIMITS,
      );

      expect(service.maxInputBytesFor('webp' as ImageFormat)).toBe(2097152);
    });
  });

  it('scans in declared priority order', () => {
    expect(
      registry()
        .detectionOrder()
        .map((entry) => entry.format),
    ).toEqual(['png', 'jpeg', 'svg']);
  });
});
