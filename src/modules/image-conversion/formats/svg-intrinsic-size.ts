import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import type { ImageConversionLimits } from './image-format-handler';

export interface IntrinsicSize {
  width: number;
  height: number;
}

/**
 * CSS absolute units, at 96 dpi.
 *
 * Fixed here rather than left to the renderer because "whatever the library
 * does" is not a specification: an SVG declaring `1in` has to come back as 96
 * pixels on every host and in every version, or the output of a conversion
 * depends on which machine ran it.
 */
const UNITS: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

/** `em`, `ex`, and `%` are relative to something this rule does not have. */
const LENGTH =
  /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/;

/**
 * Resolve one `width` or `height` attribute to CSS pixels, or `null`.
 *
 * `null` means "does not resolve", which is not the same as "invalid": a
 * `100%` width is perfectly legal SVG and simply has to come from the
 * `viewBox` instead.
 */
export function resolveLength(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const match = LENGTH.exec(value);

  if (!match) {
    return null;
  }

  const factor = UNITS[match[2].toLowerCase()];

  if (factor === undefined) {
    // `em`, `ex`, `%`, and anything unrecognised.
    return null;
  }

  return Number(match[1]) * factor;
}

/** `viewBox="min-x min-y width height"`, in user units (= px). */
export function parseViewBox(
  value: string | undefined,
): { width: number; height: number } | null {
  if (value === undefined) {
    return null;
  }

  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return { width: parts[2], height: parts[3] };
}

/**
 * The deterministic intrinsic-size rule, applied to the root `<svg>`.
 *
 * Written out rather than delegated because a vector drawing has no inherent
 * pixel size and the renderer's own answer is neither documented nor stable —
 * and because the result has to be known *before* the renderer is constructed,
 * so an oversized drawing is refused without anything being rendered (FR-018).
 *
 * Width and height resolve **independently**, so `width="200"
 * viewBox="0 0 300 150"` is 200x150 — the attribute wins where it resolves and
 * the `viewBox` fills in where it does not.
 *
 * The ceiling in step 4 runs *before* the limit check in step 5 deliberately:
 * the check is against the size that will actually be produced.
 */
export function resolveIntrinsicSize(
  attributes: {
    width?: string;
    height?: string;
    viewBox?: string;
  },
  limits: Pick<
    ImageConversionLimits,
    'maxOutputWidth' | 'maxOutputHeight' | 'maxPixels'
  >,
): IntrinsicSize {
  const viewBox = parseViewBox(attributes.viewBox);

  const width = resolveLength(attributes.width) ?? viewBox?.width ?? null;
  const height = resolveLength(attributes.height) ?? viewBox?.height ?? null;

  if (width === null || height === null) {
    throw new ConversionException(ConversionErrorCode.SVG_NO_INTRINSIC_SIZE);
  }

  // Zero and negative are refused rather than clamped: a drawing that declares
  // no area has no correct rasterisation, and picking one would be a guess.
  if (!(width > 0) || !(height > 0)) {
    throw new ConversionException(ConversionErrorCode.SVG_NO_INTRINSIC_SIZE);
  }

  // Ceiling rather than nearest, so a 10.2px drawing is never clipped.
  const pixelWidth = Math.ceil(width);
  const pixelHeight = Math.ceil(height);

  if (
    pixelWidth > limits.maxOutputWidth ||
    pixelHeight > limits.maxOutputHeight ||
    pixelWidth * pixelHeight > limits.maxPixels
  ) {
    throw new ConversionException(
      ConversionErrorCode.IMAGE_DIMENSIONS_EXCEEDED,
      {
        width: pixelWidth,
        height: pixelHeight,
        maxWidth: limits.maxOutputWidth,
        maxHeight: limits.maxOutputHeight,
      },
    );
  }

  return { width: pixelWidth, height: pixelHeight };
}
