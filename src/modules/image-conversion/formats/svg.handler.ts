import { renderAsync } from '@resvg/resvg-js';
import type { ResvgRenderOptions } from '@resvg/resvg-js';
import { Injectable } from '@nestjs/common';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import {
  DETECTION_IS_CONCLUSIVE,
  DETECTION_PRIORITY,
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
} from '../image-conversion.constants';
import type {
  ImageConversionContext,
  ImageFormatHandler,
} from './image-format-handler';
import { looksLikeSvg } from './image-signatures';
import {
  createPipelineRasterImage,
  createRasterImage,
  RasterImage,
} from './raster-image';
import { resolveIntrinsicSize } from './svg-intrinsic-size';
import { validateSvg } from './svg-security';

/**
 * SVG, as a source **only**.
 *
 * There is no `encode`, and its absence is the feature: the registry computes
 * directions from capabilities, so `png→svg` is not forbidden anywhere — it is
 * unrepresentable. Discovery cannot advertise it and the pipeline cannot reach
 * it. Adding an `encode` here would make FR-003 a rule someone has to remember
 * instead of a shape the code cannot express.
 *
 * The order inside `decode` is fixed and load-bearing: **validate, then size,
 * then render.** Nothing is rendered for a document that fails either of the
 * first two, which is what FR-018 and FR-020 actually require — checking after
 * rendering would be checking after the cost has already been paid.
 */
@Injectable()
export class SvgHandler implements ImageFormatHandler {
  readonly format = ImageFormat.SVG;
  readonly mediaType = IMAGE_MEDIA_TYPES[ImageFormat.SVG];
  readonly extension = IMAGE_EXTENSIONS[ImageFormat.SVG];
  readonly detectionPriority = DETECTION_PRIORITY[ImageFormat.SVG];
  readonly sniffIsConclusive = DETECTION_IS_CONCLUSIVE[ImageFormat.SVG];

  sniff(prefix: Buffer): boolean {
    return looksLikeSvg(prefix);
  }

  async decode(
    input: Buffer,
    context: ImageConversionContext,
  ): Promise<RasterImage> {
    // 1. Refuse active content and external references. Returns the ORIGINAL
    //    text — the validator never rewrites.
    const validated = validateSvg(input);

    // 2. Resolve the size and check it against the configured maximum, before
    //    the renderer is constructed.
    const size = resolveIntrinsicSize(validated.attributes, context.limits);

    context.signal?.throwIfAborted();

    // 3. Only now is anything rendered.
    const rendered = await this.render(validated.text, context);

    return this.fit(rendered, size, context.limits.maxPixels);
  }

  /**
   * Rasterise onto a **transparent** canvas.
   *
   * The background is not painted here: the encoder composites the request's
   * background under the image, the same way for every source. Painting it
   * here too would apply a translucent one twice — and a JPEG target still
   * gets white under a transparent drawing, because that is its encoder's
   * rule.
   */
  private async render(
    svg: string,
    context: ImageConversionContext,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const { limits } = context;
    const family = limits.svgDefaultFontFamily;
    const options: ResvgRenderOptions = {
      // No scaling: the drawing is rendered at the size the rule resolved.
      fitTo: { mode: 'original' },
      font: {
        // The bundled fonts, so `<text>` renders the same on every host. A
        // host's own fonts only when asked for: they make output depend on
        // the machine.
        loadSystemFonts: limits.svgLoadSystemFonts,
        ...(limits.svgFontDir ? { fontDirs: [limits.svgFontDir] } : {}),
        // Text naming no font, a generic family, or a font that is not
        // installed falls back to this rather than to nothing at all — resvg
        // drops a glyph it has no font for, which is how text disappeared.
        defaultFontFamily: family,
        sansSerifFamily: family,
        serifFamily: family,
        monospaceFamily: family,
        cursiveFamily: family,
        fantasyFamily: family,
      },
      logLevel: 'off',
    };

    try {
      // `renderAsync` rather than `new Resvg().render()`: it runs off the
      // event loop and honours the conversion deadline, so a pathological
      // drawing cannot block unrelated requests.
      const image = await renderAsync(svg, options, context.signal ?? null);

      // One copy of the pixels on the JS heap; the renderer's own is released
      // with `image`, which goes out of scope here.
      return { data: image.pixels, width: image.width, height: image.height };
    } catch (error) {
      if (context.signal?.aborted) {
        throw error;
      }

      // Renderer messages can quote the document; none escapes this call.
      throw new ConversionException(ConversionErrorCode.SVG_RENDER_FAILED);
    }
  }

  /**
   * Reconcile what resvg produced with the size the rule resolved.
   *
   * They agree in every case but one: the rule rounds a fractional dimension
   * **up** so a 10.2px drawing is never clipped, while resvg rounds to
   * nearest and would produce 10. Rather than let the library silently
   * redefine a documented rule, the canvas is extended to the resolved size —
   * transparently, like the rest of the canvas — and the drawing itself is
   * neither scaled nor moved, so nothing is clipped and the output is exactly
   * the size the contract promises.
   *
   * The extension is part of the hub's pipeline rather than a second buffer:
   * it happens inside libvips while the target encodes.
   */
  private fit(
    rendered: { data: Buffer; width: number; height: number },
    wanted: { width: number; height: number },
    maxPixels: number,
  ): RasterImage {
    const actual = rendered;
    const image = createRasterImage(
      { ...rendered, channels: 4, hasAlpha: true },
      { maxPixels },
    );

    if (actual.width === wanted.width && actual.height === wanted.height) {
      return image;
    }

    return createPipelineRasterImage(
      { ...wanted, channels: 4, hasAlpha: true, decodesOnRead: false },
      { maxPixels },
      () => {
        const canvas = image.toSharp().extend({
          top: 0,
          left: 0,
          right: Math.max(0, wanted.width - actual.width),
          bottom: Math.max(0, wanted.height - actual.height),
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        });

        // A resolved size *smaller* than what was rendered should be
        // impossible — ceiling is never below round — but cropping rather
        // than trusting that keeps the promised dimensions true either way.
        return actual.width > wanted.width || actual.height > wanted.height
          ? canvas.extract({
              left: 0,
              top: 0,
              width: wanted.width,
              height: wanted.height,
            })
          : canvas;
      },
    );
  }
}
