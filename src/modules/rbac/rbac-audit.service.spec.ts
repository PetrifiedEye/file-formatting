import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  RbacAuditEntityType,
  RbacAuditEvent,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { RbacAuditService } from './rbac-audit.service';

describe('RbacAuditService', () => {
  let service: RbacAuditService;

  const auditRepository = {
    create: jest.fn((data: Partial<RbacAuditEvent>) => data),
    save: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    auditRepository.save.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RbacAuditService,
        {
          provide: getRepositoryToken(RbacAuditEvent),
          useValue: auditRepository,
        },
      ],
    }).compile();

    service = module.get(RbacAuditService);
  });

  it('persists the event', async () => {
    await service.record(
      RbacAuditEventType.GRANT_CREATED,
      RbacAuditOutcome.SUCCESS,
      { entityType: RbacAuditEntityType.GRANT, entityId: 'grant-1' },
    );

    expect(auditRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'grant-1' }),
    );
  });

  it('swallows a failed write instead of failing the caller', async () => {
    // This service was the only audit service that propagated. Because
    // `PermissionGuard` records every denial, a failing audit write turned a
    // 403 into a 500 — the audit trail deciding the caller's response.
    auditRepository.save.mockRejectedValue(new Error('db unavailable'));

    await expect(
      service.record(
        RbacAuditEventType.MANAGEMENT_ACCESS_DENIED,
        RbacAuditOutcome.FAILURE,
        { actorUserId: 'user-1' },
      ),
    ).resolves.toBeUndefined();
  });
});
