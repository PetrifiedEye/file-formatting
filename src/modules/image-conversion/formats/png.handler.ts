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
import { looksLikePng } from './image-signatures';
import { overBackground } from './background';
import { RasterImage } from './raster-image';
import { decodeRaster, encodeRaster } from './sharp-raster';

/**
 * PNG, as both a source and a target.
 *
 * Greyscale, indexed-colour, and 16-bit-per-channel PNGs are all decoded and
 * normalised to 8-bit rather than refused — a caller should not have to know
 * which of the format's colour types their file happens to use.
 *
 * Alpha survives in both directions: a transparent PNG decodes with its alpha
 * channel intact, and an encode that is handed one writes it back — over the
 * request's background, which is `transparent` unless the caller named a
 * colour. What happens to that alpha when the *target* cannot hold it is the
 * JPEG handler's business, not this one's.
 */
@Injectable()
export class PngHandler implements ImageFormatHandler {
  readonly format = ImageFormat.PNG;
  readonly mediaType = IMAGE_MEDIA_TYPES[ImageFormat.PNG];
  readonly extension = IMAGE_EXTENSIONS[ImageFormat.PNG];
  readonly detectionPriority = DETECTION_PRIORITY[ImageFormat.PNG];
  readonly sniffIsConclusive = DETECTION_IS_CONCLUSIVE[ImageFormat.PNG];

  sniff(prefix: Buffer): boolean {
    return looksLikePng(prefix);
  }

  /** Header-first, budget-checked, EXIF-oriented, sRGB, alpha preserved. */
  async decode(
    input: Buffer,
    context: ImageConversionContext,
  ): Promise<RasterImage> {
    return decodeRaster(input, context, true);
  }

  async encode(
    image: RasterImage,
    context: ImageConversionContext,
  ): Promise<Buffer> {
    context.signal?.throwIfAborted();

    // No `.withMetadata()`: sharp writes none unless asked, and the hub
    // carries none to write. An opaque source stays opaque — nothing here
    // invents an alpha channel.
    return encodeRaster(image, async () =>
      (await overBackground(image, context.background)).png().toBuffer(),
    );
  }
}
