import { SettingsService } from '@/modules/settings/settings.service';

import { TransformationRetentionPolicyService } from './transformation-retention-policy.service';

describe('TransformationRetentionPolicyService', () => {
  let settings: { getTransformationRetentionPolicy: jest.Mock };
  let service: TransformationRetentionPolicyService;

  beforeEach(() => {
    settings = {
      getTransformationRetentionPolicy: jest
        .fn()
        .mockResolvedValue({ retentionDays: 90 }),
    };
    service = new TransformationRetentionPolicyService(
      settings as unknown as SettingsService,
    );
  });

  it('returns the active database-backed policy', async () => {
    await expect(service.getRetentionDays()).resolves.toBe(90);
    expect(settings.getTransformationRetentionPolicy).toHaveBeenCalledTimes(1);
  });

  it('uses the current policy on every read', async () => {
    settings.getTransformationRetentionPolicy
      .mockResolvedValueOnce({ retentionDays: 30 })
      .mockResolvedValueOnce({ retentionDays: 180 });

    await expect(service.getRetentionDays()).resolves.toBe(30);
    await expect(service.getRetentionDays()).resolves.toBe(180);
  });

  it('calculates an exact deadline without mutating the creation time', async () => {
    const createdAt = new Date('2026-09-18T10:00:00.123Z');

    await expect(service.calculateExpiresAt(createdAt)).resolves.toEqual(
      new Date('2026-12-17T10:00:00.123Z'),
    );
    expect(createdAt.toISOString()).toBe('2026-09-18T10:00:00.123Z');
  });
});
