import { ImageFormat } from '@/modules/conversion/conversion.enums';

import { RasterImage } from './raster-image';

/**
 * Every limit the image pipeline applies, resolved once from configuration and
 * handed to the handlers.
 *
 * Handlers never read `ConfigService` themselves: that keeps them
 * unit-testable against arbitrary limits and stops one from inventing a
 * ceiling of its own.
 */
export interface ImageConversionLimits {
  /** Per **source** format — the applicable limit is the detected one (FR-017). */
  maxInputBytes: Record<ImageFormat, number>;
  /** Checked *before* a renderer is constructed (FR-018). */
  maxOutputWidth: number;
  maxOutputHeight: number;
  /** Checked from the container header, before any allocation (FR-019). */
  maxPixels: number;
  maxOutputBytes: number;
  /** `#rrggbb`. What alpha is composited onto, and what SVG renders over. */
  backgroundColor: string;
  /** Fixed; never caller-supplied. */
  jpegQuality: number;
  timeoutMs: number;
  maxConcurrent: number;
  /** `null` means no fonts at all, so `<text>` renders as nothing. */
  svgFontDir: string | null;
}

/**
 * What a handler is given besides the bytes.
 *
 * One object rather than trailing positional arguments, so a handler takes only
 * what it needs and a later addition does not change every signature.
 */
export interface ImageConversionContext {
  limits: ImageConversionLimits;
  /** Expires with the conversion deadline. */
  signal?: AbortSignal;
}

/**
 * One image format, as a pair of **optional** capabilities.
 *
 * This is the whole extensibility story, and the reason FR-003 is structural
 * rather than a rule: `decode` and `encode` are independently optional, the
 * registry computes directions as *decoders × encoders minus self-pairs*, and
 * the SVG handler simply has no `encode`. `png→svg` is therefore not
 * forbidden — it is **unrepresentable**, so discovery cannot advertise it and
 * the pipeline cannot reach it.
 *
 * Adding a format is one new implementation plus one provider entry. No
 * existing handler, the controller, the DTOs, the detector, and the discovery
 * endpoint all stay untouched (FR-033, FR-034, SC-014).
 */
export interface ImageFormatHandler {
  readonly format: ImageFormat;
  readonly mediaType: string;
  /** The attachment's extension — `jpeg` owns `jpg`, so the two may differ. */
  readonly extension: string;

  /**
   * Where this format sits in the detection scan — lower runs first. Declared
   * by the handler rather than hard-coded in the detector, so a new format
   * slots itself into the order without the detector learning about it.
   */
  readonly detectionPriority: number;

  /**
   * Whether a passing {@link sniff} settles the question on its own.
   *
   * Every image signature is unambiguous, so all three are conclusive — which
   * is what keeps "I sent the wrong kind of file" (415) distinguishable from
   * "I sent a broken file of the right kind" (400 `image_invalid`).
   */
  readonly sniffIsConclusive: boolean;

  /**
   * A cheap check against the bounded upload prefix. Never a full decode — the
   * prefix may stop mid-file.
   *
   * `namedByFileName` says the upload's extension named *this* format. It may
   * only ever **widen** what a handler will consider, never narrow it: content
   * decides, and the extension stays the secondary hint FR-004 calls for.
   */
  sniff(prefix: Buffer, namedByFileName: boolean): boolean;

  /**
   * Read the bytes into the canonical hub, or throw a `ConversionException`
   * carrying a fixed code.
   *
   * Absent means the format cannot be a conversion *source*.
   */
  decode?(input: Buffer, context: ImageConversionContext): Promise<RasterImage>;

  /**
   * Write the hub out **completely**. The pipeline sends the returned buffer
   * only once it exists in full, which is what makes a partial image
   * unrepresentable (FR-012).
   *
   * Absent means the format cannot be a conversion *target*. That absence is
   * load-bearing for SVG — see the interface note above.
   */
  encode?(image: RasterImage, context: ImageConversionContext): Promise<Buffer>;
}

/** Multi-provider token: every registered {@link ImageFormatHandler}. */
export const IMAGE_FORMAT_HANDLERS = Symbol('IMAGE_FORMAT_HANDLERS');

/** The resolved {@link ImageConversionLimits} for this process. */
export const IMAGE_CONVERSION_LIMITS = Symbol('IMAGE_CONVERSION_LIMITS');
