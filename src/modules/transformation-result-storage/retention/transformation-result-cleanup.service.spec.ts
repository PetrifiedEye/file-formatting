import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { ConversionFileStorageService } from '@/core/storage/conversion-file-storage.service';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';

import { TransformationResultCleanupService } from './transformation-result-cleanup.service';

describe('TransformationResultCleanupService', () => {
  let rows: Record<string, unknown>[];
  let query: Record<string, jest.Mock>;
  let records: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let storage: { remove: jest.Mock };
  let config: { get: jest.Mock };
  let service: TransformationResultCleanupService;

  beforeEach(() => {
    rows = [];
    query = {};
    for (const name of [
      'leftJoinAndSelect',
      'select',
      'where',
      'orderBy',
      'addOrderBy',
      'take',
      'andWhere',
    ]) {
      query[name] = jest.fn().mockReturnValue(query);
    }
    query.getMany = jest.fn(() => Promise.resolve(rows));
    records = {
      createQueryBuilder: jest.fn().mockReturnValue(query),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = { remove: jest.fn().mockResolvedValue('removed') };
    config = { get: jest.fn().mockReturnValue('0') };
    service = new TransformationResultCleanupService(
      records as unknown as Repository<ConversionRecord>,
      storage as unknown as ConversionFileStorageService,
      config as unknown as ConfigService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses a minimal ordered bounded expiry query', async () => {
    await service.runCleanupCycle(new Date('2026-09-18T10:00:00.000Z'));

    expect(query.select).toHaveBeenCalledWith([
      'record.id',
      'record.expiresAt',
      'storedFile.id',
      'storedFile.storagePath',
    ]);
    expect(query.where).toHaveBeenCalledWith('record.expiresAt <= :now', {
      now: new Date('2026-09-18T10:00:00.000Z'),
    });
    expect(query.orderBy).toHaveBeenCalledWith('record.expiresAt', 'ASC');
    expect(query.addOrderBy).toHaveBeenCalledWith('record.id', 'ASC');
    expect(query.take).toHaveBeenCalledWith(100);
  });

  it('unlinks before deleting the row', async () => {
    rows = [expired('a', 'owner/a.json')];

    await expect(service.runCleanupCycle()).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });

    expect(storage.remove.mock.invocationCallOrder[0]).toBeLessThan(
      records.delete.mock.invocationCallOrder[0],
    );
    expect(records.delete).toHaveBeenCalledWith({ id: 'a' });
  });

  it('deletes expired history that has no stored file', async () => {
    rows = [expired('a', null)];

    await service.runCleanupCycle();

    expect(storage.remove).not.toHaveBeenCalled();
    expect(records.delete).toHaveBeenCalledWith({ id: 'a' });
  });

  it('isolates one unlink failure and continues later items', async () => {
    rows = [expired('a', 'owner/a.json'), expired('b', 'owner/b.json')];
    storage.remove
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce('removed');

    await expect(service.runCleanupCycle()).resolves.toEqual({
      deleted: 1,
      failed: 1,
    });

    expect(records.delete).not.toHaveBeenCalledWith({ id: 'a' });
    expect(records.delete).toHaveBeenCalledWith({ id: 'b' });
  });

  it('retains a row for retry when database deletion fails after unlink', async () => {
    rows = [expired('a', 'owner/a.json')];
    records.delete.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.runCleanupCycle()).resolves.toEqual({
      deleted: 0,
      failed: 1,
    });
    expect(storage.remove).toHaveBeenCalled();
  });

  it('does not schedule when the interval is disabled', () => {
    service.onModuleInit();

    expect(
      (service as unknown as { timer: NodeJS.Timeout | null }).timer,
    ).toBeNull();
  });

  it('starts an unrefed timer and stops it on destroy', () => {
    const unref = jest.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const interval = jest.spyOn(global, 'setInterval').mockReturnValue(timer);
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation();
    config.get.mockReturnValue('3600000');

    service.onModuleInit();
    service.onModuleDestroy();

    expect(interval).toHaveBeenCalledWith(expect.any(Function), 3600000);
    expect(unref).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

function expired(id: string, storagePath: string | null) {
  return {
    id,
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    storedFile: storagePath ? { id: `file-${id}`, storagePath } : null,
  };
}
