import sharp from 'sharp';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import type { ImageConversionContext } from './image-format-handler';
import { createRasterImage, RasterImage } from './raster-image';

/**
 * The decode both raster handlers share, and the pixel budget that guards it.
 *
 * PNG and JPEG differ in exactly one respect — whether alpha may survive — so
 * the container-independent part lives here rather than being written twice
 * and drifting. Every step is deliberate:
 *
 * 1. **Header first.** `metadata()` parses the container header and nothing
 *    else, so the declared dimensions are known before a pixel buffer exists.
 *    The budget is checked against *that*, which is what makes a 229-byte file
 *    declaring 900 megapixels a refusal with no measurable memory rise
 *    (FR-019, SC-007). Checking after the allocation is precisely the failure
 *    being guarded against.
 * 2. **`limitInputPixels` on the decode**, as a second line of defence against
 *    a container whose header and payload disagree.
 * 3. **`rotate()`** applies EXIF orientation to the pixels, so the output is
 *    upright and `width`/`height` mean what a viewer shows.
 * 4. **`toColourspace('srgb')`** normalises greyscale, indexed, and
 *    16-bit-per-channel input to 8-bit sRGB rather than refusing it, and drops
 *    the source colour profile.
 *
 * `animated: false` is sharp's default, so a multi-frame container yields its
 * first frame.
 */

/** Read the declared size without allocating a pixel buffer. */
export async function readHeader(
  input: Buffer,
): Promise<{ width: number; height: number; hasAlpha: boolean }> {
  let metadata: sharp.Metadata;

  try {
    // `limitInputPixels: false` so an oversized declaration reaches *our*
    // check and is reported with its own code and the numbers involved,
    // rather than surfacing as a library message about a pixel limit.
    metadata = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    // Library messages quote the input; none of them escapes this call.
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  const { width, height } = metadata;

  if (!width || !height) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  // Orientations 5-8 transpose the raster. The pixel *count* is the same
  // either way, which is all the budget cares about.
  return { width, height, hasAlpha: metadata.hasAlpha === true };
}

/** Refuse a declaration over the budget, before anything is allocated. */
export function enforcePixelBudget(
  width: number,
  height: number,
  maxPixels: number,
): void {
  if (width * height > maxPixels) {
    throw new ConversionException(
      ConversionErrorCode.IMAGE_PIXEL_BUDGET_EXCEEDED,
      { pixels: width * height, limit: maxPixels },
    );
  }
}

/**
 * Decode `input` into the canonical hub.
 *
 * `keepAlpha` is the one thing the two raster formats disagree about: a PNG's
 * transparency is carried into the hub, while a JPEG has none to carry and
 * must not have one invented.
 */
export async function decodeRaster(
  input: Buffer,
  context: ImageConversionContext,
  keepAlpha: boolean,
): Promise<RasterImage> {
  const header = await readHeader(input);
  enforcePixelBudget(header.width, header.height, context.limits.maxPixels);

  const withAlpha = keepAlpha && header.hasAlpha;

  let pipeline = sharp(input, {
    limitInputPixels: context.limits.maxPixels,
  })
    .rotate()
    .toColourspace('srgb');

  pipeline = withAlpha ? pipeline.ensureAlpha() : pipeline.removeAlpha();

  let decoded: { data: Buffer; info: sharp.OutputInfo };

  try {
    decoded = await pipeline
      // `uchar` is what normalises a 16-bit-per-channel source to 8.
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  return createRasterImage(
    {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
      hasAlpha: withAlpha,
    },
    { maxPixels: context.limits.maxPixels },
  );
}

/** A sharp pipeline reading the hub back, ready to be encoded. */
export function fromRaster(image: RasterImage): sharp.Sharp {
  return sharp(image.data, {
    raw: {
      width: image.width,
      height: image.height,
      channels: image.channels,
    },
  });
}
