import { Injectable } from '@nestjs/common';

import { ImageFormat } from '@/modules/conversion/conversion.enums';

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
import { looksLikeJpeg } from './image-signatures';
import { opaqueBackground } from './background';
import { RasterImage } from './raster-image';
import { decodeRaster, encodeRaster } from './sharp-raster';

/**
 * JPEG, as both a source and a target.
 *
 * The format cannot hold transparency, which makes this handler the one place
 * FR-009 is decided: an image arriving with alpha is **composited onto the
 * request's background** rather than having its alpha dropped — dropping it
 * would turn a transparent region into whatever colour happened to sit in the
 * unused channel, which is how transparent logos come out black. A background
 * that is itself transparent (the default) or translucent is composited onto
 * white first, so there is always an opaque colour to flatten onto.
 *
 * Quality is `IMAGE_JPEG_QUALITY` and is never caller-supplied: a request
 * parameter here would be a knob with no correct value and an obvious abuse
 * (quality 100 on a large image, repeatedly).
 */
@Injectable()
export class JpegHandler implements ImageFormatHandler {
  readonly format = ImageFormat.JPEG;
  readonly mediaType = IMAGE_MEDIA_TYPES[ImageFormat.JPEG];
  readonly extension = IMAGE_EXTENSIONS[ImageFormat.JPEG];
  readonly detectionPriority = DETECTION_PRIORITY[ImageFormat.JPEG];
  readonly sniffIsConclusive = DETECTION_IS_CONCLUSIVE[ImageFormat.JPEG];

  sniff(prefix: Buffer): boolean {
    return looksLikeJpeg(prefix);
  }

  /**
   * Header-first, budget-checked, EXIF-oriented, sRGB.
   *
   * `keepAlpha: false` is not an optimisation — a JPEG has no alpha, so
   * inventing a fully-opaque fourth channel here would make every JPEG→PNG
   * result claim transparency it does not have.
   */
  async decode(
    input: Buffer,
    context: ImageConversionContext,
  ): Promise<RasterImage> {
    return decodeRaster(input, context, false);
  }

  async encode(
    image: RasterImage,
    context: ImageConversionContext,
  ): Promise<Buffer> {
    context.signal?.throwIfAborted();

    return encodeRaster(image, () =>
      image
        .toSharp()
        // Unconditional: flattening an already-opaque image is a no-op, and
        // making it conditional would add a branch whose false side is the
        // bug. The result is fully opaque either way (SC-003).
        .flatten({ background: opaqueBackground(context.background) })
        .jpeg({ quality: context.limits.jpegQuality })
        .toBuffer(),
    );
  }
}
