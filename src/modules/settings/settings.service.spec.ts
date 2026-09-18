import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  SettingsAuditEventType,
  SettingsAuditOutcome,
} from './entities/settings-audit-event.entity';
import { SettingsAuditService } from './settings-audit.service';
import { SystemSettings } from './entities/system-settings.entity';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;
  const repository = {
    findOne: jest.fn(),
    save: jest.fn((settings) => Promise.resolve(settings)),
  };

  const settingsAuditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  const baseSettings: SystemSettings = {
    id: 1,
    registrationConfirmationEnabled: false,
    passwordRecoveryConfirmationEnabled: false,
    signInConfirmationEnabled: false,
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireDigit: false,
    passwordRequireSpecial: false,
    transformationHistoryRetentionDays: 90,
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repository.findOne.mockResolvedValue({ ...baseSettings });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: getRepositoryToken(SystemSettings), useValue: repository },
        { provide: SettingsAuditService, useValue: settingsAuditService },
      ],
    }).compile();

    service = module.get(SettingsService);
  });

  it('returns singleton settings', async () => {
    const settings = await service.getSettings();
    expect(settings.id).toBe(1);
  });

  it('returns the active transformation retention policy', async () => {
    await expect(service.getTransformationRetentionPolicy()).resolves.toEqual({
      retentionDays: 90,
    });
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('updates and audits the transformation retention policy', async () => {
    await expect(
      service.updateTransformationRetentionPolicy(
        { retentionDays: 180 },
        { actorUserId: 'admin-1', ipAddress: '10.0.0.9', userAgent: 'jest' },
      ),
    ).resolves.toEqual({ retentionDays: 180 });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ transformationHistoryRetentionDays: 180 }),
    );
    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
      SettingsAuditOutcome.SUCCESS,
      {
        actorUserId: 'admin-1',
        ipAddress: '10.0.0.9',
        userAgent: 'jest',
        changes: {
          retentionDays: { from: 90, to: 180 },
        },
      },
    );
  });

  it('persists and audits an idempotent retention policy update', async () => {
    await expect(
      service.updateTransformationRetentionPolicy(
        { retentionDays: 90 },
        { actorUserId: 'admin-1' },
      ),
    ).resolves.toEqual({ retentionDays: 90 });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
      SettingsAuditOutcome.SUCCESS,
      expect.objectContaining({ changes: {} }),
    );
  });

  it('audits a retention persistence failure and rethrows it', async () => {
    repository.save.mockRejectedValueOnce(new Error('retention write failed'));

    await expect(
      service.updateTransformationRetentionPolicy(
        { retentionDays: 180 },
        { actorUserId: 'admin-1' },
      ),
    ).rejects.toThrow('retention write failed');

    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
      SettingsAuditOutcome.FAILURE,
      expect.objectContaining({
        changes: { retentionDays: { from: 90, to: 180 } },
        reason: 'retention write failed',
      }),
    );
  });

  it('does not fail a persisted retention update when auditing fails', async () => {
    settingsAuditService.record.mockRejectedValueOnce(new Error('audit down'));

    await expect(
      service.updateTransformationRetentionPolicy({ retentionDays: 180 }),
    ).resolves.toEqual({ retentionDays: 180 });
  });

  it('updates independent confirmation flags', async () => {
    const updated = await service.updateConfirmationPolicy({
      registrationConfirmationEnabled: true,
      passwordRecoveryConfirmationEnabled: true,
    });

    expect(updated.registrationConfirmationEnabled).toBe(true);
    expect(updated.passwordRecoveryConfirmationEnabled).toBe(true);
    expect(updated.signInConfirmationEnabled).toBe(false);
  });

  it('updates password policy fields', async () => {
    const updated = await service.updateConfirmationPolicy({
      passwordMinLength: 12,
      passwordRequireUppercase: true,
    });

    expect(updated.passwordMinLength).toBe(12);
    expect(updated.passwordRequireUppercase).toBe(true);
  });

  it('audits every changed field with its before and after value', async () => {
    await service.updateConfirmationPolicy(
      { signInConfirmationEnabled: true, passwordMinLength: 12 },
      { actorUserId: 'admin-1', ipAddress: '10.0.0.9', userAgent: 'jest' },
    );

    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      SettingsAuditOutcome.SUCCESS,
      {
        actorUserId: 'admin-1',
        ipAddress: '10.0.0.9',
        userAgent: 'jest',
        changes: {
          signInConfirmationEnabled: { from: false, to: true },
          passwordMinLength: { from: 8, to: 12 },
        },
      },
    );
  });

  it('does not report a field the request left unchanged as a change', async () => {
    await service.updateConfirmationPolicy(
      { signInConfirmationEnabled: false },
      { actorUserId: 'admin-1' },
    );

    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      SettingsAuditOutcome.SUCCESS,
      expect.objectContaining({ changes: {} }),
    );
  });

  it('audits a failure when the write throws, and rethrows', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.updateConfirmationPolicy(
        { signInConfirmationEnabled: true },
        { actorUserId: 'admin-1' },
      ),
    ).rejects.toThrow('db down');

    expect(settingsAuditService.record).toHaveBeenCalledWith(
      SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      SettingsAuditOutcome.FAILURE,
      expect.objectContaining({ reason: 'db down' }),
    );
  });
});
