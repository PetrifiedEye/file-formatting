import { Repository } from 'typeorm';

import {
  ConversionFileStorageService,
  ConversionStorageError,
} from '@/core/storage/conversion-file-storage.service';

import { ConversionFormat } from './conversion.enums';
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
}) {
  const save =
    overrides.save ?? jest.fn().mockResolvedValue('user-1/file.json');
  const del = overrides.del ?? jest.fn().mockResolvedValue(undefined);
  const insert = overrides.insert ?? jest.fn().mockResolvedValue(undefined);
  const update = overrides.update ?? jest.fn().mockResolvedValue(undefined);

  const service = new ConversionRetentionService(
    { insert } as unknown as Repository<ConversionStoredFile>,
    { update } as unknown as Repository<ConversionRecord>,
    { save, delete: del } as unknown as ConversionFileStorageService,
  );

  return { service, save, del, insert, update };
}

const request = {
  userId: 'user-1',
  format: ConversionFormat.JSON,
  extension: 'json',
  buffer: BUFFER,
};

describe('ConversionRetentionService', () => {
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
