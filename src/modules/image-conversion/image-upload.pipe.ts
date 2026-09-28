import { Injectable } from '@nestjs/common';

import { ImageFormat } from '@/modules/conversion/conversion.enums';
import type { UploadAttempt } from '@/modules/conversion/upload/multipart-upload';
import { MultipartUploadPipe } from '@/modules/conversion/upload/multipart-upload.pipe';
import { UploadReader } from '@/modules/conversion/upload/upload-reader';

import { ImageFormatRegistryService } from './detection/image-format-registry.service';
import { convertImageRequestDtoSchema } from './dto/convert-image-request.dto';
import { ImageConversionService } from './image-conversion.service';
import type {
  ImageUploadFields,
  ReceivedImage,
} from './image-conversion.service';

/** Reads a `POST /api/images/convert` upload: an image to convert. */
@Injectable()
export class ImageUploadPipe extends MultipartUploadPipe<
  ReceivedImage,
  ImageFormat,
  ImageUploadFields
> {
  protected readonly fieldsSchema = convertImageRequestDtoSchema;

  constructor(
    private readonly images: ImageConversionService,
    private readonly registry: ImageFormatRegistryService,
  ) {
    super();
  }

  protected maxInputBytes(): number {
    return this.registry.maxConfiguredInputBytes();
  }

  protected supportsTarget(format: ImageFormat): boolean {
    return this.registry.handlerFor(format) !== undefined;
  }

  protected receive(
    reader: UploadReader,
    attempt: UploadAttempt<ImageFormat>,
  ): Promise<ReceivedImage> {
    return this.images.receive(reader, attempt);
  }
}
