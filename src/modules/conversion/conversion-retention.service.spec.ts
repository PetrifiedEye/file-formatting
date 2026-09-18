import { Repository } from 'typeorm';

import {
  ConversionFileStorageService,
  ConversionStorageError,
} from '@/core/storage/conversion-file-storage.service';
import { TransformationResultAuditService } from '@/modules/transformation-result-storage/transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from '@/modules/transformation-result-storage/transformation-result.enums';

import {
  ConversionFormat,
  ConversionRetentionOutcome,
} from './conversion.enums';
import {
  ConversionRetentionService,
  StoredFile,
} from './conversion-retention.service';
import { ConversionRecord } from './entities/conversion-record.entity';
import { ConversionStoredFile } from './entities/conversion-stored-file.entity';

jest.mock('typeorm-transactional', () => ({
  // The decorator's job is atomicity against a real database; the e2e suite
  // covers that. Here it must simply not swallow anything.
  Transactional: () => () => undefined,
}));

const BUFFER = Buffer.from('{"a":1}\n', 'utf8');

function serviceWith(overrides: {
  save?: jest.Mock;
  del?: jest.Mock;
  insert?: jest.Mock;
  update?: jest.Mock;
  audit?: jest.Mock;
}) {
  const save =
    overrides.save ?? jest.fn().mockResolvedValue('user-1/file.json');
  const del = overrides.del ?? jest.fn().mockResolvedValue(undefined);
  const insert = overrides.insert ?? jest.fn().mockResolvedValue(undefined);
  const update = overrides.update ?? jest.fn().mockResolvedValue(undefined);
  const audit = overrides.audit ?? jest.fn().mockResolvedValue(undefined);

  const service = new ConversionRetentionService(
    { insert } as unknown as Repository<ConversionStoredFile>,
    { update } as unknown as Repository<ConversionRecord>,
    { save, delete: del } as unknown as ConversionFileStorageService,
    { record: audit } as unknown as TransformationResultAuditService,
  );

  return { service, save, del, insert, update, audit };
}

const request = {
  userId: 'user-1',
  format: ConversionFormat.JSON,
  extension: 'json',
  buffer: BUFFER,
};

describe('ConversionRetentionService', () => {
  describe('finalize', () => {
    const finalization = {
      userId: 'user-1',
      conversionRecordId: 'record-1',
      retentionRequested: true,
      result: request,
      maxSizeBytes: BUFFER.length,
    };

    it('writes only after history exists, attaches, and audits one success', async () => {
      const { service, save, insert, update, audit } = serviceWith({});

      const outcome = await service.finalize(finalization);

      expect(outcome).toMatchObject({
        retentionOutcome: ConversionRetentionOutcome.STORED,
        storedFileId: expect.any(String) as string,
        auditOutcome: TransformationResultAuditOutcome.SUCCESS,
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(save.mock.invocationCallOrder[0]).toBeLessThan(
        insert.mock.invocationCallOrder[0],
      );
      expect(insert.mock.invocationCallOrder[0]).toBeLessThan(
        update.mock.invocationCallOrder[0],
      );
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        audit.mock.invocationCallOrder[0],
      );
      expect(audit).toHaveBeenCalledWith({
        actorUserId: 'user-1',
        conversionRecordId: 'record-1',
        storedFileId: expect.any(String) as string,
        action: TransformationResultAuditAction.SAVE,
        outcome: TransformationResultAuditOutcome.SUCCESS,
        fileSizeBytes: BUFFER.length,
        durationMs: expect.any(Number) as number,
      });
    });

    it('does nothing and writes no save audit when retention was not requested', async () => {
      const { service, save, audit } = serviceWith({});

      await expect(
        service.finalize({
          ...finalization,
          retentionRequested: false,
        }),
      ).resolves.toEqual({
        retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
        storedFileId: null,
        auditOutcome: null,
      });
      expect(save).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('audits a failed conversion without writing a file', async () => {
      const { service, save, audit } = serviceWith({});

      const outcome = await service.finalize({
        ...finalization,
        result: null,
      });

      expect(outcome.auditOutcome).toBe(
        TransformationResultAuditOutcome.CONVERSION_FAILED,
      );
      expect(save).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          storedFileId: null,
          fileSizeBytes: null,
          outcome: TransformationResultAuditOutcome.CONVERSION_FAILED,
        }),
      );
    });

    it('rechecks the applicable output limit before storage', async () => {
      const { service, save, audit } = serviceWith({});

      const outcome = await service.finalize({
        ...finalization,
        maxSizeBytes: BUFFER.length - 1,
      });

      expect(outcome.auditOutcome).toBe(
        TransformationResultAuditOutcome.SIZE_EXCEEDED,
      );
      expect(outcome.retentionOutcome).toBe(ConversionRetentionOutcome.FAILED);
      expect(save).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: TransformationResultAuditOutcome.SIZE_EXCEEDED,
          fileSizeBytes: BUFFER.length,
        }),
      );
    });

    it('requires a history id before writing private bytes', async () => {
      const { service, save, audit } = serviceWith({});

      const outcome = await service.finalize({
        ...finalization,
        conversionRecordId: null,
      });

      expect(outcome.auditOutcome).toBe(
        TransformationResultAuditOutcome.HISTORY_UNAVAILABLE,
      );
      expect(save).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          conversionRecordId: null,
          outcome: TransformationResultAuditOutcome.HISTORY_UNAVAILABLE,
        }),
      );
    });

    it('contains a storage failure and audits it once', async () => {
      const { service, audit } = serviceWith({
        save: jest.fn().mockRejectedValue(new ConversionStorageError()),
      });

      await expect(service.finalize(finalization)).resolves.toMatchObject({
        retentionOutcome: ConversionRetentionOutcome.FAILED,
        auditOutcome: TransformationResultAuditOutcome.STORAGE_FAILED,
      });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: TransformationResultAuditOutcome.STORAGE_FAILED,
        }),
      );
    });

    it('discards an orphan and audits one transactional attach failure', async () => {
      const { service, del, audit } = serviceWith({
        insert: jest.fn().mockRejectedValue(new Error('constraint')),
      });

      const outcome = await service.finalize(finalization);

      expect(outcome).toMatchObject({
        retentionOutcome: ConversionRetentionOutcome.FAILED,
        storedFileId: expect.any(String) as string,
        auditOutcome: TransformationResultAuditOutcome.ATTACH_FAILED,
      });
      expect(del).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(del.mock.invocationCallOrder[0]).toBeLessThan(
        audit.mock.invocationCallOrder[0],
      );
    });

    it('contains discard and audit failures without changing the outcome', async () => {
      const { service, audit } = serviceWith({
        insert: jest.fn().mockRejectedValue(new Error('constraint')),
        del: jest.fn().mockRejectedValue(new Error('disk offline')),
        audit: jest.fn().mockRejectedValue(new Error('audit offline')),
      });

      await expect(service.finalize(finalization)).resolves.toMatchObject({
        retentionOutcome: ConversionRetentionOutcome.FAILED,
        auditOutcome: TransformationResultAuditOutcome.ATTACH_FAILED,
      });
      expect(audit).toHaveBeenCalledTimes(1);
    });
  });

  describe('store', () => {
    it('writes the result and describes what it wrote', async () => {
      const { service, save } = serviceWith({});

      const stored = await service.store(request);

      expect(save).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        'json',
        BUFFER,
      );
      expect(stored).toMatchObject({
        userId: 'user-1',
        format: ConversionFormat.JSON,
        sizeBytes: BUFFER.length,
        storagePath: 'user-1/file.json',
      });
      expect(stored?.id).toEqual(expect.any(String));
    });

    it('touches no table — nothing is recorded until it is linked', async () => {
      const { service, insert, update } = serviceWith({});

      await service.store(request);

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('reports a storage failure as null, never as an exception', async () => {
      // FR-028: the conversion succeeded. Turning a failed copy into a failed
      // conversion would discard a result the caller is entitled to.
      const { service } = serviceWith({
        save: jest.fn().mockRejectedValue(new ConversionStorageError()),
      });

      await expect(service.store(request)).resolves.toBeNull();
    });

    it('gives every stored file its own identity', async () => {
      const { service } = serviceWith({});

      const first = await service.store(request);
      const second = await service.store(request);

      expect(first?.id).not.toBe(second?.id);
    });
  });

  describe('attach', () => {
    const stored: StoredFile = {
      id: 'file-1',
      userId: 'user-1',
      format: ConversionFormat.JSON,
      sizeBytes: BUFFER.length,
      storagePath: 'user-1/file-1.json',
    };

    it('writes the row and the record link together', async () => {
      const { service, insert, update } = serviceWith({});

      await expect(service.attach('record-1', stored)).resolves.toBe(true);

      expect(insert).toHaveBeenCalledWith({
        id: 'file-1',
        userId: 'user-1',
        conversionRecordId: 'record-1',
        format: ConversionFormat.JSON,
        sizeBytes: BUFFER.length,
        storagePath: 'user-1/file-1.json',
      });
      expect(update).toHaveBeenCalledWith(
        { id: 'record-1' },
        { retentionOutcome: 'stored', storedFileId: 'file-1' },
      );
    });

    it('does not mark the record stored when the row insert fails', async () => {
      const { service, update } = serviceWith({
        insert: jest.fn().mockRejectedValue(new Error('unique violation')),
      });

      await expect(service.attach('record-1', stored)).rejects.toBeDefined();
      expect(update).not.toHaveBeenCalled();
    });

    it('propagates a link failure so the transaction rolls back', async () => {
      // The caller turns this into `failed`; swallowing it here would leave
      // the record claiming a file it is not linked to.
      const { service } = serviceWith({
        update: jest.fn().mockRejectedValue(new Error('deadlock detected')),
      });

      await expect(service.attach('record-1', stored)).rejects.toBeDefined();
    });
  });

  describe('discard', () => {
    it('removes a file that could not be attached', async () => {
      // A file nothing points at is unreachable and would never be cleaned up.
      const { service, del } = serviceWith({});

      await service.discard({
        id: 'file-1',
        userId: 'user-1',
        format: ConversionFormat.JSON,
        sizeBytes: 8,
        storagePath: 'user-1/file-1.json',
      });

      expect(del).toHaveBeenCalledWith('user-1/file-1.json');
    });
  });
});
