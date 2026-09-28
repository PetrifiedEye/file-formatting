import { Injectable } from '@nestjs/common';

import { ConversionFormat } from '@/modules/conversion/conversion.enums';
import type { ReceivedUpload } from '@/modules/conversion/conversion.service';
import { ConversionService } from '@/modules/conversion/conversion.service';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { convertRequestDtoSchema } from '@/modules/conversion/dto/convert-request.dto';

import type { UploadAttempt } from './multipart-upload';
import { MultipartUploadPipe } from './multipart-upload.pipe';
import { UploadReader } from './upload-reader';

/** Reads a `POST /api/convert` upload: a text document to convert. */
@Injectable()
export class DocumentUploadPipe extends MultipartUploadPipe<
  ReceivedUpload,
  ConversionFormat
> {
  protected readonly fieldsSchema = convertRequestDtoSchema;

  constructor(
    private readonly conversion: ConversionService,
    private readonly registry: FormatRegistryService,
  ) {
    super();
  }

  protected maxInputBytes(): number {
    return this.registry.maxConfiguredInputBytes();
  }

  protected supportsTarget(format: ConversionFormat): boolean {
    return this.registry.handlerFor(format) !== undefined;
  }

  /**
   * Reads and decodes the file. Its format is settled later, by the
   * conversion's detection parse, which records it on the attempt then.
   */
  protected receive(
    reader: UploadReader,
    attempt: UploadAttempt<ConversionFormat>,
  ): Promise<ReceivedUpload> {
    return this.conversion.receive(reader, attempt.originalFileName);
  }
}
