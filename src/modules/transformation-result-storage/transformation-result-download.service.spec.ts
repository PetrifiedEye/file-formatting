import { HttpStatus } from '@nestjs/common';
import { Readable } from 'stream';
import { Repository } from 'typeorm';

import {
  ConversionStorageFileMissingError,
  ConversionStorageReadError,
  ConversionFileStorageService,
} from '@/core/storage/conversion-file-storage.service';
import {
  ConversionFormat,
  ConversionOutcome,
  ConversionRetentionOutcome,
  ImageFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';

import { TransformationResultAuditOutcome } from './transformation-result.enums';
import {
  TransformationResultDownloadException,
  TransformationResultDownloadService,
} from './transformation-result-download.service';

const OWNER = '00000000-0000-4000-8000-000000000001';
const RECORD = '00000000-0000-4000-8000-000000000002';
const FILE = '00000000-0000-4000-8000-000000000003';

describe('TransformationResultDownloadService', () => {
  let row: Record<string, unknown> | null;
  let query: Record<string, jest.Mock>;
  let storage: { openForRead: jest.Mock };
  let service: TransformationResultDownloadService;

  beforeEach(() => {
    row = downloadableRow();
    query = {};
    for (const name of ['leftJoinAndSelect', 'select', 'where', 'andWhere']) {
      query[name] = jest.fn().mockReturnValue(query);
    }
    query.getOne = jest.fn(() => Promise.resolve(row));
    storage = {
      openForRead: jest.fn().mockImplementation(() =>
        Promise.resolve({
          stream: Readable.from(Buffer.from('test')),
          size: 4,
        }),
      ),
    };
    service = new TransformationResultDownloadService(
      {
        createQueryBuilder: jest.fn().mockReturnValue(query),
      } as unknown as Repository<ConversionRecord>,
      storage as unknown as ConversionFileStorageService,
    );
  });

  it('uses an owner-scoped explicit-select query', async () => {
    await service.prepare(OWNER, RECORD);

    expect(query.where).toHaveBeenCalledWith(
      'record.id = :conversionRecordId',
      { conversionRecordId: RECORD },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'record.userId = :expectedOwnerId',
      { expectedOwnerId: OWNER },
    );
    const calls = query.select.mock.calls as [string[]][];
    const [selected] = calls[0];
    expect(selected).toContain('storedFile.storagePath');
    expect(selected).not.toContain('record.originalFileName');
    expect(selected).not.toContain('record.failureReason');
  });

  it.each([
    [ConversionFormat.CSV, 'converted.csv', 'text/csv'],
    [ConversionFormat.JSON, 'converted.json', 'application/json'],
    [ConversionFormat.XML, 'converted.xml', 'application/xml'],
    [ConversionFormat.YAML, 'converted.yaml', 'application/yaml'],
  ])('maps trusted document metadata for %s', async (format, name, media) => {
    row = downloadableRow({ targetFormat: format, format });

    await expect(service.prepare(OWNER, RECORD)).resolves.toMatchObject({
      fileName: name,
      mediaType: media,
      size: 4,
    });
  });

  it.each([
    [ImageFormat.PNG, 'converted-image.png', 'image/png'],
    [ImageFormat.JPEG, 'converted-image.jpg', 'image/jpeg'],
  ])('maps trusted image metadata for %s', async (format, name, media) => {
    row = downloadableRow({
      transformationType: TransformationType.IMAGE,
      targetFormat: format,
      format,
    });

    await expect(service.prepare(OWNER, RECORD)).resolves.toMatchObject({
      fileName: name,
      mediaType: media,
    });
  });

  it.each([
    ['unknown or cross-owner record', () => null],
    [
      'unsaved record',
      () =>
        downloadableRow({
          retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
          storedFile: null,
          storedFileId: null,
        }),
    ],
    [
      'failed conversion',
      () => downloadableRow({ outcome: ConversionOutcome.FAILURE }),
    ],
  ])('uses one unavailable response for an %s', async (_label, build) => {
    row = build();

    await expect(service.prepare(OWNER, RECORD)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      message: 'Transformation result not available',
      auditOutcome: TransformationResultAuditOutcome.NOT_FOUND,
    });
    expect(storage.openForRead).not.toHaveBeenCalled();
  });

  it('refuses an expired row before touching storage', async () => {
    row = downloadableRow({
      expiresAt: new Date('2026-09-18T09:59:59.999Z'),
    });

    await expect(
      service.prepare(OWNER, RECORD, new Date('2026-09-18T10:00:00.000Z')),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      auditOutcome: TransformationResultAuditOutcome.EXPIRED,
    });
    expect(storage.openForRead).not.toHaveBeenCalled();
  });

  it('maps missing backing storage to uniform unavailable', async () => {
    storage.openForRead.mockRejectedValue(
      new ConversionStorageFileMissingError(),
    );

    await expect(service.prepare(OWNER, RECORD)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      auditOutcome: TransformationResultAuditOutcome.UNAVAILABLE,
    });
  });

  it('maps unexpected pre-open failures to a detail-free 500', async () => {
    storage.openForRead.mockRejectedValue(new ConversionStorageReadError());

    let error: unknown;
    try {
      await service.prepare(OWNER, RECORD);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TransformationResultDownloadException);
    expect(error).toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      auditOutcome: TransformationResultAuditOutcome.STORAGE_FAILED,
      message: 'Unable to download transformation result',
    });
    expect(JSON.stringify(error)).not.toContain('storage/');
  });

  it('treats descriptor/metadata size drift as unavailable', async () => {
    storage.openForRead.mockResolvedValue({
      stream: Readable.from(Buffer.from('drift')),
      size: 5,
    });

    await expect(service.prepare(OWNER, RECORD)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      auditOutcome: TransformationResultAuditOutcome.UNAVAILABLE,
    });
  });

  it('refuses format metadata drift before opening storage', async () => {
    row = downloadableRow({
      storedFile: {
        id: FILE,
        userId: OWNER,
        conversionRecordId: RECORD,
        format: ConversionFormat.CSV,
        sizeBytes: 4,
        storagePath: `${OWNER}/${FILE}.csv`,
      },
    });

    await expect(service.prepare(OWNER, RECORD)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      auditOutcome: TransformationResultAuditOutcome.UNAVAILABLE,
    });
    expect(storage.openForRead).not.toHaveBeenCalled();
  });

  it('opens an independent descriptor on every request', async () => {
    const first = await service.prepare(OWNER, RECORD);
    const second = await service.prepare(OWNER, RECORD);

    expect(storage.openForRead).toHaveBeenCalledTimes(2);
    expect(first.stream).not.toBe(second.stream);
  });
});

function downloadableRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const format = overrides.format ?? ConversionFormat.JSON;
  return {
    id: RECORD,
    userId: OWNER,
    transformationType: TransformationType.FILE,
    targetFormat: ConversionFormat.JSON,
    outcome: ConversionOutcome.SUCCESS,
    retentionOutcome: ConversionRetentionOutcome.STORED,
    storedFileId: FILE,
    outputSizeBytes: 4,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    storedFile: {
      id: FILE,
      userId: OWNER,
      conversionRecordId: RECORD,
      format,
      sizeBytes: 4,
      storagePath: `${OWNER}/${FILE}.json`,
    },
    ...overrides,
  };
}
