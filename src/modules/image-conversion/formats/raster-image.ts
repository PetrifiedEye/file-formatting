import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

/**
 * The canonical hub every conversion passes through: raw pixels and nothing
 * else.
 *
 * `decode(source) → RasterImage → encode(target)`, so N decoders and M encoders
 * give N×M−|both| directions with no pairwise code anywhere.
 *
 * **It has no metadata field, and that is the mechanism.** EXIF, GPS, camera
 * data, and colour profiles cannot cross the hub because there is nowhere for
 * them to sit — FR-026's "no embedded metadata in the result" is enforced by
 * shape rather than by every handler remembering to strip something.
 */
export interface RasterImage {
  /** Row-major, 8 bits per channel, `width * height * channels` bytes long. */
  readonly data: Buffer;
  /** Post-orientation: what a viewer shows, not what the container stored. */
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly hasAlpha: boolean;
}

/** Only the ceiling the hub itself enforces; the full set lives in limits. */
export interface RasterImageBudget {
  maxPixels: number;
}

/**
 * Build a {@link RasterImage}, refusing anything that is not one.
 *
 * The invariants are checked here rather than trusted from each decoder, so a
 * handler that miscounts channels fails at its own boundary instead of writing
 * a corrupt picture several steps later. The pixel budget is checked again as
 * well — the authoritative check is the header read that happens *before* any
 * allocation, and this is the backstop for a container whose header and
 * payload disagree.
 */
export function createRasterImage(
  image: {
    data: Buffer;
    width: number;
    height: number;
    channels: number;
    hasAlpha: boolean;
  },
  budget: RasterImageBudget,
): RasterImage {
  const { data, width, height, channels, hasAlpha } = image;

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

  if (data.length !== width * height * channels) {
    throw new ConversionException(ConversionErrorCode.IMAGE_INVALID);
  }

  if (width * height > budget.maxPixels) {
    throw new ConversionException(
      ConversionErrorCode.IMAGE_PIXEL_BUDGET_EXCEEDED,
      { pixels: width * height, limit: budget.maxPixels },
    );
  }

  return { data, width, height, channels, hasAlpha };
}
