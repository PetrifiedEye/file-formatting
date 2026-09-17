import { renderAsync } from '@resvg/resvg-js';
import type { ResvgRenderOptions } from '@resvg/resvg-js';
import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

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
import { createRasterImage, RasterImage } from './raster-image';
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
    const rendered = await this.render(validated.text, size, context);

    return createRasterImage(
      {
        data: rendered.data,
        width: rendered.width,
        height: rendered.height,
        channels: 4,
        hasAlpha: true,
      },
      { maxPixels: context.limits.maxPixels },
    );
  }

  private async render(
    svg: string,
    size: { width: number; height: number },
    context: ImageConversionContext,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const options: ResvgRenderOptions = {
      // No scaling: the drawing is rendered at the size the rule resolved.
      fitTo: { mode: 'original' },
      background: context.limits.backgroundColor,
      font: {
        // Off, so rendering is deterministic and the renderer never scans the
        // filesystem. The documented consequence: with no font directory
        // configured, `<text>` renders as nothing. Substituting whatever font
        // a host happens to have would make output non-reproducible.
        loadSystemFonts: false,
        ...(context.limits.svgFontDir
          ? { fontDirs: [context.limits.svgFontDir] }
          : {}),
      },
      logLevel: 'off',
    };

    let width: number;
    let height: number;
    let pixels: Buffer;

    try {
      // `renderAsync` rather than `new Resvg().render()`: it runs off the
      // event loop and honours the conversion deadline, so a pathological
      // drawing cannot block unrelated requests.
      const image = await renderAsync(svg, options, context.signal ?? null);

      width = image.width;
      height = image.height;
      pixels = image.pixels;
    } catch (error) {
      if (context.signal?.aborted) {
        throw error;
      }

      // Renderer messages can quote the document; none escapes this call.
      throw new ConversionException(ConversionErrorCode.SVG_RENDER_FAILED);
    }

    return this.fit(
      pixels,
      { width, height },
      size,
      context.limits.backgroundColor,
    );
  }

  /**
   * Reconcile what resvg produced with the size the rule resolved.
   *
   * They agree in every case but one: the rule rounds a fractional dimension
   * **up** so a 10.2px drawing is never clipped, while resvg rounds to
   * nearest and would produce 10. Rather than let the library silently
   * redefine a documented rule, the canvas is extended to the resolved size
   * with the background colour — the drawing itself is neither scaled nor
   * moved, so nothing is clipped and the output is exactly the size the
   * contract promises.
   */
  private async fit(
    pixels: Buffer,
    actual: { width: number; height: number },
    wanted: { width: number; height: number },
    background: string,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    if (actual.width === wanted.width && actual.height === wanted.height) {
      return { data: pixels, width: actual.width, height: actual.height };
    }

    const canvas = sharp(pixels, {
      raw: { width: actual.width, height: actual.height, channels: 4 },
    }).extend({
      top: 0,
      left: 0,
      right: Math.max(0, wanted.width - actual.width),
      bottom: Math.max(0, wanted.height - actual.height),
      // The same colour the drawing was rendered over, so an extended edge is
      // indistinguishable from the canvas it extends.
      background,
    });

    // A resolved size *smaller* than what was rendered should be impossible —
    // ceiling is never below round — but cropping rather than trusting that
    // keeps the promised dimensions true either way.
    const bounded =
      actual.width > wanted.width || actual.height > wanted.height
        ? canvas.extract({
            left: 0,
            top: 0,
            width: wanted.width,
            height: wanted.height,
          })
        : canvas;

    const { data, info } = await bounded
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data, width: info.width, height: info.height };
  }
}
