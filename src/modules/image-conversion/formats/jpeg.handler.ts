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
import { looksLikeJpeg } from './image-signatures';
import { RasterImage } from './raster-image';
import { decodeRaster, fromRaster } from './sharp-raster';

/**
 * JPEG, as both a source and a target.
 *
 * The format cannot hold transparency, which makes this handler the one place
 * FR-009 is decided: an image arriving with alpha is **composited onto the
 * configured background** rather than having its alpha dropped — dropping it
 * would turn a transparent region into whatever colour happened to sit in the
 * unused channel, which is how transparent logos come out black.
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

    try {
      return await fromRaster(image)
        // Unconditional: flattening an already-opaque image is a no-op, and
        // making it conditional would add a branch whose false side is the
        // bug. The result is fully opaque either way (SC-003).
        .flatten({ background: context.limits.backgroundColor })
        .jpeg({ quality: context.limits.jpegQuality })
        .toBuffer();
    } catch {
      throw new ConversionException(ConversionErrorCode.INTERNAL_ERROR);
    }
  }
}
