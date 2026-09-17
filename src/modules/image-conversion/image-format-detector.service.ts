import { Injectable } from '@nestjs/common';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import { IMAGE_EXTENSION_HINTS } from './image-conversion.constants';
import { ImageFormatRegistryService } from './image-format-registry.service';

/**
 * Decides what an upload is from its **bytes**.
 *
 * Feature 010's `FormatDetectorService` is deliberately not reused: it decodes
 * UTF-8 and reasons about text, which is meaningless for a PNG. The two share
 * only the bounded-prefix constant.
 *
 * Content decides and the file name is a secondary hint only, so a `.png` file
 * containing JPEG bytes is converted as JPEG (FR-004). Every image signature
 * is unambiguous, so a match is conclusive — which is what keeps a corrupt PNG
 * a 400 `image_invalid` rather than a 415 "unsupported".
 */
@Injectable()
export class ImageFormatDetectorService {
  constructor(private readonly registry: ImageFormatRegistryService) {}

  /**
   * The format `prefix` is, or `null` if nothing recognises it.
   *
   * Handlers are tried in their own declared priority order, so a new format
   * slots into the scan without this service learning about it.
   */
  detect(prefix: Buffer, originalFileName: string): ImageFormat | null {
    const named = this.namedByFileName(originalFileName);

    for (const handler of this.registry.detectionOrder()) {
      if (handler.sniff(prefix, named === handler.format)) {
        return handler.format;
      }
    }

    return null;
  }

  /** {@link detect}, or the 415 the contract documents. */
  require(prefix: Buffer, originalFileName: string): ImageFormat {
    const format = this.detect(prefix, originalFileName);

    if (format === null) {
      throw new ConversionException(
        ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
      );
    }

    return format;
  }

  /** The format the upload's extension names, if any. A hint, never a verdict. */
  private namedByFileName(originalFileName: string): ImageFormat | undefined {
    const extension = originalFileName.split('.').pop()?.toLowerCase();

    return extension ? IMAGE_EXTENSION_HINTS[extension] : undefined;
  }
}
