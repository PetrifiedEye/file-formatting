import sharp from 'sharp';

import type { RasterImage } from './raster-image';

/**
 * What transparent pixels are composited onto, parsed from `transparent` (the
 * default — they stay transparent), `#rrggbb`, or `#rrggbbaa`
 * (`BACKGROUND_COLOR_PATTERN` in `core/validation/joi-fields`).
 */
export interface Background {
  r: number;
  g: number;
  b: number;
  /** 0 (transparent) to 1 (opaque). */
  alpha: number;
}

export const TRANSPARENT: Background = { r: 0, g: 0, b: 0, alpha: 0 };

const WHITE = { r: 255, g: 255, b: 255 };

/** Parses a value already checked against `BACKGROUND_COLOR_PATTERN`. */
export function parseBackground(value: string): Background {
  if (value === 'transparent') {
    return TRANSPARENT;
  }

  const channel = (offset: number) =>
    parseInt(value.slice(offset, offset + 2), 16);

  return {
    r: channel(1),
    g: channel(3),
    b: channel(5),
    alpha: value.length === 9 ? channel(7) / 255 : 1,
  };
}

/**
 * The background as a JPEG can use it. JPEG has no alpha, so there is always
 * *some* opaque colour under a transparent pixel: the requested one where it
 * is opaque, composited onto white where it is not — so a transparent source
 * still comes out white, not the black of whatever sat in the unused channel.
 */
export function opaqueBackground(background: Background): {
  r: number;
  g: number;
  b: number;
} {
  const over = (channel: number, white: number) =>
    Math.round(channel * background.alpha + white * (1 - background.alpha));

  return {
    r: over(background.r, WHITE.r),
    g: over(background.g, WHITE.g),
    b: over(background.b, WHITE.b),
  };
}

/**
 * The image composited over `background`, for a target that keeps alpha
 * (PNG). Nothing to do for an opaque image or a transparent background; an
 * opaque background is a flatten; a translucent one is layered under the
 * image, keeping the result's alpha.
 *
 * The translucent case is the one path that materialises the image (as an
 * intermediate PNG) — it needs the image as a composite input.
 */
export async function overBackground(
  image: RasterImage,
  background: Background,
): Promise<sharp.Sharp> {
  const pixels = image.toSharp();

  if (!image.hasAlpha || background.alpha === 0) {
    return pixels;
  }

  if (background.alpha === 1) {
    const { r, g, b } = background;
    return pixels.flatten({ background: { r, g, b } });
  }

  const layer = await pixels.png().toBuffer();

  return sharp({
    create: {
      width: image.width,
      height: image.height,
      channels: 4,
      background,
    },
  }).composite([{ input: layer }]);
}
