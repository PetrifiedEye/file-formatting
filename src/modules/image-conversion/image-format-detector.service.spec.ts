import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import {
  looksLikeJpeg,
  looksLikePng,
  looksLikeSvg,
} from './formats/image-signatures';
import {
  DETECTION_PRIORITY,
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  JPEG_SIGNATURE,
  PNG_SIGNATURE,
  UTF8_BOM,
} from './image-conversion.constants';
import { ImageFormatDetectorService } from './image-format-detector.service';
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
 * Handlers wired to the *real* signature predicates — the same functions the
 * three production handlers delegate to — so this exercises detection as it
 * actually behaves, without constructing a decoder.
 */
const SNIFFERS: Record<ImageFormat, (prefix: Buffer) => boolean> = {
  [ImageFormat.PNG]: looksLikePng,
  [ImageFormat.JPEG]: looksLikeJpeg,
  [ImageFormat.SVG]: looksLikeSvg,
};

function handler(format: ImageFormat): ImageFormatHandler {
  return {
    format,
    mediaType: IMAGE_MEDIA_TYPES[format],
    extension: IMAGE_EXTENSIONS[format],
    detectionPriority: DETECTION_PRIORITY[format],
    sniffIsConclusive: true,
    sniff: (prefix) => SNIFFERS[format](prefix),
    decode: jest.fn(),
    ...(format === ImageFormat.SVG ? {} : { encode: jest.fn() }),
  } as ImageFormatHandler;
}

function detector(): ImageFormatDetectorService {
  return new ImageFormatDetectorService(
    new ImageFormatRegistryService(
      [
        handler(ImageFormat.PNG),
        handler(ImageFormat.JPEG),
        handler(ImageFormat.SVG),
      ],
      LIMITS,
    ),
  );
}

const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('IHDR-ish payload')]);
const JPEG = Buffer.concat([JPEG_SIGNATURE, Buffer.from([0xe0, 0x00, 0x10])]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
);

describe('ImageFormatDetectorService', () => {
  it.each([
    ['png', PNG, ImageFormat.PNG],
    ['jpeg', JPEG, ImageFormat.JPEG],
    ['svg', SVG, ImageFormat.SVG],
  ])('detects %s from its signature alone', (_name, bytes, expected) => {
    expect(detector().detect(bytes, '')).toBe(expected);
  });

  /**
   * FR-004: content decides. A file named `.png` that is actually a JPEG is
   * converted as a JPEG rather than refused or mis-decoded.
   */
  it('detects JPEG bytes in a file named .png as JPEG', () => {
    expect(detector().detect(JPEG, 'holiday.png')).toBe(ImageFormat.JPEG);
  });

  it('detects PNG bytes in a file named .jpg as PNG', () => {
    expect(detector().detect(PNG, 'holiday.jpg')).toBe(ImageFormat.PNG);
  });

  it('detects an SVG behind a BOM and leading whitespace', () => {
    const bytes = Buffer.concat([
      UTF8_BOM,
      Buffer.from('\n\n   \t'),
      Buffer.from('<?xml version="1.0"?>\n'),
      SVG,
    ]);

    expect(detector().detect(bytes, 'drawing.svg')).toBe(ImageFormat.SVG);
  });

  it('detects an SVG with no file name at all', () => {
    expect(detector().detect(SVG, '')).toBe(ImageFormat.SVG);
  });

  it.each([
    ['plain text', Buffer.from('just some words')],
    ['a JSON document', Buffer.from('{"a":1}')],
    // A leading `<` alone must not claim a format: feature 010 converts XML.
    ['a non-SVG XML document', Buffer.from('<?xml version="1.0"?><root/>')],
    ['a GIF', Buffer.from('GIF89a......')],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns null for %s', (_name, bytes) => {
    expect(detector().detect(bytes, 'file.png')).toBeNull();
  });

  it('will not call a text file an SVG because it mentions one', () => {
    const bytes = Buffer.from('This document explains how <svg> elements work');

    expect(detector().detect(bytes, 'notes.svg')).toBeNull();
  });

  it('refuses an unrecognised prefix with the documented 415', () => {
    try {
      detector().require(Buffer.from('GIF89a'), 'x.gif');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionException);
      expect((error as ConversionException).code).toBe(
        'unsupported_source_format',
      );
    }
  });

  // Signature scans run on a bounded window that may stop mid-character; a
  // split multi-byte sequence must not make detection throw.
  it('survives a prefix cut through a multi-byte character', () => {
    const svg = Buffer.from(
      '<svg width="1" height="1"><text>日本</text></svg>',
    );

    expect(() => detector().detect(svg.subarray(0, 32), '')).not.toThrow();
  });
});
