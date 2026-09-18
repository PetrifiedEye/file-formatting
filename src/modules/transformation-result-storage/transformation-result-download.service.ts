import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ReadStream } from 'fs';
import { Repository } from 'typeorm';

import {
  ConversionStorageFileMissingError,
  ConversionStorageReadError,
  ConversionFileStorageService,
  type OpenedConversionFile,
} from '@/core/storage/conversion-file-storage.service';
import {
  FORMAT_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
} from '@/modules/conversion/conversion.constants';
import {
  ConversionFormat,
  ConversionOutcome,
  ConversionRetentionOutcome,
  ImageFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';
import {
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
} from '@/modules/image-conversion/image-conversion.constants';

import { TransformationResultAuditOutcome } from './transformation-result.enums';

const UNAVAILABLE_MESSAGE = 'Transformation result not available';

interface DownloadRecord extends ConversionRecord {
  expiresAt: Date;
}

export interface TransformationResultDownload {
  conversionRecordId: string;
  storedFileId: string;
  stream: ReadStream;
  fileName: string;
  mediaType: string;
  size: number;
}

export class TransformationResultDownloadException extends HttpException {
  constructor(
    readonly auditOutcome: TransformationResultAuditOutcome,
    status: HttpStatus,
  ) {
    super(
      status === HttpStatus.NOT_FOUND
        ? UNAVAILABLE_MESSAGE
        : 'Unable to download transformation result',
      status,
    );
  }
}

@Injectable()
export class TransformationResultDownloadService {
  constructor(
    @InjectRepository(ConversionRecord)
    private readonly records: Repository<ConversionRecord>,
    private readonly storage: ConversionFileStorageService,
  ) {}

  async prepare(
    expectedOwnerId: string,
    conversionRecordId: string,
    now = new Date(),
  ): Promise<TransformationResultDownload> {
    const record = (await this.records
      .createQueryBuilder('record')
      .leftJoinAndSelect('record.storedFile', 'storedFile')
      .select([
        'record.id',
        'record.userId',
        'record.transformationType',
        'record.targetFormat',
        'record.outcome',
        'record.retentionOutcome',
        'record.storedFileId',
        'record.outputSizeBytes',
        'record.expiresAt',
        'storedFile.id',
        'storedFile.userId',
        'storedFile.conversionRecordId',
        'storedFile.format',
        'storedFile.sizeBytes',
        'storedFile.storagePath',
      ])
      .where('record.id = :conversionRecordId', { conversionRecordId })
      .andWhere('record.userId = :expectedOwnerId', { expectedOwnerId })
      .getOne()) as DownloadRecord | null;

    if (!record) {
      throw unavailable(TransformationResultAuditOutcome.NOT_FOUND);
    }
    if (record.expiresAt.getTime() <= now.getTime()) {
      throw unavailable(TransformationResultAuditOutcome.EXPIRED);
    }
    if (
      record.outcome !== ConversionOutcome.SUCCESS ||
      record.retentionOutcome !== ConversionRetentionOutcome.STORED ||
      !record.storedFileId ||
      !record.storedFile
    ) {
      throw unavailable(TransformationResultAuditOutcome.NOT_FOUND);
    }
    if (
      record.storedFile.id !== record.storedFileId ||
      record.storedFile.userId !== expectedOwnerId ||
      record.storedFile.conversionRecordId !== record.id ||
      record.storedFile.format !== record.targetFormat
    ) {
      throw unavailable(TransformationResultAuditOutcome.UNAVAILABLE);
    }

    const responseMetadata = this.responseMetadata(
      record.transformationType,
      record.targetFormat,
    );

    let opened: OpenedConversionFile;
    try {
      opened = await this.storage.openForRead(record.storedFile.storagePath);
    } catch (error) {
      if (error instanceof ConversionStorageFileMissingError) {
        throw unavailable(TransformationResultAuditOutcome.UNAVAILABLE);
      }
      if (error instanceof ConversionStorageReadError) {
        throw new TransformationResultDownloadException(
          TransformationResultAuditOutcome.STORAGE_FAILED,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
      throw error;
    }

    if (
      opened.size !== record.storedFile.sizeBytes ||
      (record.outputSizeBytes !== null &&
        opened.size !== record.outputSizeBytes)
    ) {
      opened.stream.destroy();
      throw unavailable(TransformationResultAuditOutcome.UNAVAILABLE);
    }

    return {
      conversionRecordId: record.id,
      storedFileId: record.storedFile.id,
      stream: opened.stream,
      fileName: responseMetadata.fileName,
      mediaType: responseMetadata.mediaType,
      size: opened.size,
    };
  }

  private responseMetadata(
    type: TransformationType,
    format: ConversionRecord['targetFormat'],
  ): { fileName: string; mediaType: string } {
    if (
      type === TransformationType.FILE &&
      format !== null &&
      Object.values(ConversionFormat).includes(format as ConversionFormat)
    ) {
      const documentFormat = format as ConversionFormat;
      return {
        fileName: `converted.${FORMAT_EXTENSIONS[documentFormat]}`,
        mediaType: FORMAT_MEDIA_TYPES[documentFormat],
      };
    }

    if (
      type === TransformationType.IMAGE &&
      format !== null &&
      Object.values(ImageFormat).includes(format as ImageFormat)
    ) {
      const imageFormat = format as ImageFormat;
      return {
        fileName: `converted-image.${IMAGE_EXTENSIONS[imageFormat]}`,
        mediaType: IMAGE_MEDIA_TYPES[imageFormat],
      };
    }

    throw unavailable(TransformationResultAuditOutcome.UNAVAILABLE);
  }
}

function unavailable(
  outcome: TransformationResultAuditOutcome,
): TransformationResultDownloadException {
  return new TransformationResultDownloadException(
    outcome,
    HttpStatus.NOT_FOUND,
  );
}
