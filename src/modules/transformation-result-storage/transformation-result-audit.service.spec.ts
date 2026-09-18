import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { TransformationResultAuditEvent } from './entities/transformation-result-audit-event.entity';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';

describe('TransformationResultAuditService', () => {
  let create: jest.Mock;
  let save: jest.Mock;
  let loggedError: jest.SpyInstance;
  let service: TransformationResultAuditService;

  beforeEach(() => {
    create = jest.fn((value: unknown) => value);
    save = jest.fn().mockResolvedValue(undefined);
    service = new TransformationResultAuditService({
      create,
      save,
    } as unknown as Repository<TransformationResultAuditEvent>);
    loggedError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('persists every structured field and clamps duration to non-negative', async () => {
    await service.record({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      targetUserId: '00000000-0000-4000-8000-000000000002',
      conversionRecordId: '00000000-0000-4000-8000-000000000003',
      storedFileId: '00000000-0000-4000-8000-000000000004',
      action: TransformationResultAuditAction.DOWNLOAD,
      outcome: TransformationResultAuditOutcome.SUCCESS,
      fileSizeBytes: 42,
      durationMs: -10,
    });

    expect(create).toHaveBeenCalledWith({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      targetUserId: '00000000-0000-4000-8000-000000000002',
      conversionRecordId: '00000000-0000-4000-8000-000000000003',
      storedFileId: '00000000-0000-4000-8000-000000000004',
      action: TransformationResultAuditAction.DOWNLOAD,
      outcome: TransformationResultAuditOutcome.SUCCESS,
      fileSizeBytes: 42,
      durationMs: 0,
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('defaults optional identifiers and size to null', async () => {
    await service.record({
      action: TransformationResultAuditAction.SAVE,
      outcome: TransformationResultAuditOutcome.HISTORY_UNAVAILABLE,
      durationMs: 1.8,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        targetUserId: null,
        conversionRecordId: null,
        storedFileId: null,
        fileSizeBytes: null,
        durationMs: 1,
      }),
    );
  });

  it('never lets repository failure escape', async () => {
    save.mockRejectedValue(new Error('database down'));

    await expect(
      service.record({
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.STORAGE_FAILED,
        durationMs: 2,
      }),
    ).resolves.toBeUndefined();
    expect(loggedError).toHaveBeenCalled();
  });

  it('has no field capable of storing bytes, names, or paths', () => {
    const entity = new TransformationResultAuditEvent();
    const serialized = JSON.stringify(entity);

    expect(serialized).not.toContain('buffer');
    expect(serialized).not.toContain('fileName');
    expect(serialized).not.toContain('storagePath');
  });
});
