import sharp from 'sharp';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import type { ImageConversionContext } from './image-format-handler';
import { createPipelineRasterImage, RasterImage } from './raster-image';

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

/** EXIF orientations 5–8 transpose the raster: width and height swap. */
const TRANSPOSING_ORIENTATIONS = new Set([5, 6, 7, 8]);

/** Read the declared size without allocating a pixel buffer. */
export async function readHeader(input: Buffer): Promise<{
  width: number;
  height: number;
  hasAlpha: boolean;
  transposed: boolean;
}> {
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
  // either way, which is all the budget cares about; the hub's dimensions
  // are the upright ones.
  return {
    width,
    height,
    hasAlpha: metadata.hasAlpha === true,
    transposed: TRANSPOSING_ORIENTATIONS.has(metadata.orientation ?? 1),
  };
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
 * Nothing is decoded yet: the hub carries the pipeline, and the pixels are
 * produced — tile by tile, inside libvips — only while the target encodes
 * them. A file whose header is fine but whose payload is not is therefore
 * found out at encode time, and reported as `image_invalid` all the same
 * (`decodesOnRead`).
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

  return createPipelineRasterImage(
    {
      width: header.transposed ? header.height : header.width,
      height: header.transposed ? header.width : header.height,
      channels: withAlpha ? 4 : 3,
      hasAlpha: withAlpha,
      decodesOnRead: true,
    },
    { maxPixels: context.limits.maxPixels },
    () => {
      const pipeline = sharp(input, {
        // The second line of defence: a payload larger than its header.
        limitInputPixels: context.limits.maxPixels,
      })
        .rotate()
        // Also what normalises a 16-bit-per-channel source to 8, and a
        // greyscale or indexed one to three colour channels (plus its alpha).
        .toColourspace('srgb');

      // Alpha is dropped only where the target format must not keep it.
      // (Never `ensureAlpha()`: sharp applies it last, so it would put alpha
      // back after a background had been flattened in.)
      return header.hasAlpha && !withAlpha ? pipeline.removeAlpha() : pipeline;
    },
  );
}

/**
 * Run an encode, reporting a failure as the input's fault when producing the
 * pixels still decodes the upload (a truncated payload behind a valid header)
 * and as ours otherwise.
 */
export async function encodeRaster(
  image: RasterImage,
  encode: () => Promise<Buffer>,
): Promise<Buffer> {
  try {
    return await encode();
  } catch {
    // Library messages quote the input; none of them escapes this call.
    throw new ConversionException(
      image.decodesOnRead
        ? ConversionErrorCode.IMAGE_INVALID
        : ConversionErrorCode.INTERNAL_ERROR,
    );
  }
}
