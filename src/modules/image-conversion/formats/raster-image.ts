import sharp from 'sharp';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

/**
 * The canonical hub every conversion passes through: pixels and nothing else.
 *
 * `decode(source) → RasterImage → encode(target)`, so N decoders and M encoders
 * give N×M−|both| directions with no pairwise code anywhere.
 *
 * **It has no metadata field, and that is the mechanism.** EXIF, GPS, camera
 * data, and colour profiles cannot cross the hub because there is nowhere for
 * them to sit — FR-026's "no embedded metadata in the result" is enforced by
 * shape rather than by every handler remembering to strip something. (sharp
 * writes no metadata unless asked to, and nothing here asks.)
 *
 * **Its pixels are a pipeline, not a buffer.** A decoded PNG or JPEG is never
 * expanded into a `width × height × channels` buffer on the JS heap: the hub
 * describes how to produce the pixels, and the encoder runs decode and encode
 * as one libvips pass over tiles. That is what keeps a 16-megapixel conversion
 * from holding a 64 MiB raw frame (plus libvips' own) for its whole duration.
 */
export interface RasterImage {
  /** Post-orientation: what a viewer shows, not what the container stored. */
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly hasAlpha: boolean;
  /**
   * Whether producing the pixels still decodes the upload. A failure while
   * encoding is then the *input's* fault (`image_invalid`), not ours.
   */
  readonly decodesOnRead: boolean;
  /**
   * A new sharp pipeline yielding exactly these pixels: 8 bits per channel,
   * `channels` of them, `width × height`. Each call is independent.
   */
  toSharp(): sharp.Sharp;
}

interface RasterGeometry {
  width: number;
  height: number;
  channels: number;
  hasAlpha: boolean;
}

/** Only the ceiling the hub itself enforces; the full set lives in limits. */
export interface RasterImageBudget {
  maxPixels: number;
}

/**
 * Build a {@link RasterImage} over pixels already in memory (a rendered SVG),
 * refusing anything that is not one.
 *
 * The invariants are checked here rather than trusted from each decoder, so a
 * handler that miscounts channels fails at its own boundary instead of writing
 * a corrupt picture several steps later. The pixel budget is checked again as
 * well — the authoritative check is the header read that happens *before* any
 * allocation, and this is the backstop for a container whose header and
 * payload disagree.
 */
export function createRasterImage(
  image: RasterGeometry & { data: Buffer },
  budget: RasterImageBudget,
): RasterImage {
  const { data, width, height, channels } = image;

  assertGeometry(image, budget);

  if (data.length !== width * height * channels) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  return {
    ...geometryOf(image),
    decodesOnRead: false,
    toSharp: () =>
      sharp(data, { raw: { width, height, channels: channels as 3 | 4 } }),
  };
}

/**
 * Build a {@link RasterImage} whose pixels are produced on demand by
 * `pipeline` — a decode, or a transform of pixels in memory. The geometry is
 * checked now; the pixels are only ever materialised inside libvips, while
 * the encoder runs.
 */
export function createPipelineRasterImage(
  image: RasterGeometry & { decodesOnRead: boolean },
  budget: RasterImageBudget,
  pipeline: () => sharp.Sharp,
): RasterImage {
  assertGeometry(image, budget);

  return {
    ...geometryOf(image),
    decodesOnRead: image.decodesOnRead,
    toSharp: pipeline,
  };
}

function geometryOf(image: RasterGeometry): {
  width: number;
  height: number;
  channels: 3 | 4;
  hasAlpha: boolean;
} {
  return {
    width: image.width,
    height: image.height,
    channels: image.channels as 3 | 4,
    hasAlpha: image.hasAlpha,
  };
}

function assertGeometry(
  image: RasterGeometry,
  budget: RasterImageBudget,
): void {
  const { width, height, channels, hasAlpha } = image;

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  if (width < 1 || height < 1) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  if (channels !== 3 && channels !== 4) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  // An alpha flag with three channels would make transparency silently
  // unrepresentable in a picture that claims to carry it.
  if (hasAlpha && channels !== 4) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  if (width * height > budget.maxPixels) {
    throw new ConversionException(
      ConversionErrorCode.IMAGE_PIXEL_BUDGET_EXCEEDED,
      { pixels: width * height, limit: budget.maxPixels },
    );
  }
}
