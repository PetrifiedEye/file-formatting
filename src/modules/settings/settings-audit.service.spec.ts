import { Logger } from '@nestjs/common';

import {
  SettingsAuditEvent,
  SettingsAuditEventType,
  SettingsAuditOutcome,
} from './entities/settings-audit-event.entity';
import { SettingsAuditService } from './settings-audit.service';

describe('SettingsAuditService', () => {
  const repository = {
    create: jest.fn((data: Partial<SettingsAuditEvent>) => data),
    save: jest.fn(),
  };
  const service = new SettingsAuditService(repository as never);

  beforeEach(() => {
    repository.create.mockClear();
    repository.save.mockReset().mockResolvedValue(undefined);
  });

  it('records the event with every optional field defaulted', async () => {
    await service.record(
      SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      SettingsAuditOutcome.SUCCESS,
    );

    expect(repository.save).toHaveBeenCalledWith({
      eventType: SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      outcome: SettingsAuditOutcome.SUCCESS,
      actorUserId: null,
      changes: {},
      reason: null,
      ipAddress: null,
      userAgent: null,
    });
  });

  it('records the context it is given', async () => {
    await service.record(
      SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
      SettingsAuditOutcome.FAILURE,
      {
        actorUserId: 'admin-1',
        changes: { retentionDays: { from: 90, to: 30 } },
        reason: 'validation',
        ipAddress: '10.0.0.1',
        userAgent: 'curl',
      },
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin-1',
        changes: { retentionDays: { from: 90, to: 30 } },
        reason: 'validation',
        ipAddress: '10.0.0.1',
        userAgent: 'curl',
      }),
    );
  });

  it('never lets a failed audit write fail the change it describes', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    repository.save.mockRejectedValue(new Error('database is down'));

    await expect(
      service.record(
        SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
        SettingsAuditOutcome.SUCCESS,
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
