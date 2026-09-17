import { DETECTION_PREFIX_BYTES } from '@/modules/conversion/conversion.constants';
import { ImageFormat } from '@/modules/conversion/conversion.enums';

/**
 * How much of the upload is buffered before the source format is decided.
 *
 * Re-exported from feature 010 rather than redefined: the two pipelines read
 * the same bounded prefix for the same reason — the per-format byte budget is
 * only knowable once the format is, and that budget is what stops an oversized
 * upload from being read to the end (SC-008).
 */
export const IMAGE_DETECTION_PREFIX_BYTES = DETECTION_PREFIX_BYTES;

/** The leading bytes that identify each container. */
export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** UTF-8 BOM, skipped before an SVG's leading `<` is looked for. */
export const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Scan order. Lower runs first; the binary signatures are cheapest and most
 * specific, so they go before the SVG text scan.
 */
export const DETECTION_PRIORITY: Record<ImageFormat, number> = {
  [ImageFormat.PNG]: 10,
  [ImageFormat.JPEG]: 20,
  [ImageFormat.SVG]: 30,
};

/**
 * Every image signature is unambiguous, so a match settles the question.
 *
 * That is what makes a PNG with corrupt pixel data a 400 `image_invalid`
 * rather than a 415 — a caller must be able to tell "wrong kind of file" from
 * "broken file of the right kind".
 */
export const DETECTION_IS_CONCLUSIVE: Record<ImageFormat, boolean> = {
  [ImageFormat.PNG]: true,
  [ImageFormat.JPEG]: true,
  [ImageFormat.SVG]: true,
};

export const IMAGE_MEDIA_TYPES: Record<ImageFormat, string> = {
  [ImageFormat.PNG]: 'image/png',
  [ImageFormat.JPEG]: 'image/jpeg',
  [ImageFormat.SVG]: 'image/svg+xml',
};

/** `jpeg` carries the conventional `jpg`; the two are free to differ. */
export const IMAGE_EXTENSIONS: Record<ImageFormat, string> = {
  [ImageFormat.PNG]: 'png',
  [ImageFormat.JPEG]: 'jpg',
  [ImageFormat.SVG]: 'svg',
};

/**
 * File-name extensions that hint at a format.
 *
 * Content decides: a `.png` file containing JPEG bytes is converted as JPEG
 * (FR-004). This only ever widens what a handler will consider.
 */
export const IMAGE_EXTENSION_HINTS: Record<string, ImageFormat> = {
  png: ImageFormat.PNG,
  jpg: ImageFormat.JPEG,
  jpeg: ImageFormat.JPEG,
  svg: ImageFormat.SVG,
};

/** The attachment name is fixed, never derived from the upload (FR-011). */
export const CONVERTED_IMAGE_BASE_NAME = 'converted';

/**
 * Reports what happened to a `store=true` request alongside a binary body.
 *
 * Named distinctly from `/api/convert`'s `X-Conversion-Retention` so a client
 * wiring up both endpoints cannot confuse them.
 */
export const IMAGE_RETENTION_HEADER = 'X-Image-Conversion-Retention';
