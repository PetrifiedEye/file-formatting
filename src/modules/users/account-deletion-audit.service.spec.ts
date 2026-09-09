import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccountDeletionAuditService } from './account-deletion-audit.service';
import {
  AccountDeletionAuditAction,
  AccountDeletionAuditEvent,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';

describe('AccountDeletionAuditService', () => {
  let service: AccountDeletionAuditService;
  const savedEvents: Partial<AccountDeletionAuditEvent>[] = [];

  const repository = {
    create: jest.fn((data: Partial<AccountDeletionAuditEvent>) => data),
    save: jest.fn((event: Partial<AccountDeletionAuditEvent>) => {
      savedEvents.push(event);
      return Promise.resolve(event);
    }),
  };

  beforeEach(async () => {
    savedEvents.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionAuditService,
        {
          provide: getRepositoryToken(AccountDeletionAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(AccountDeletionAuditService);
  });

  it('creates and saves an audit row with the given actor/target/action/outcome and no PII fields', async () => {
    await service.record(
      'actor-1',
      'target-1',
      AccountDeletionAuditAction.SELF_DELETE_CONFIRMED,
      AccountDeletionAuditOutcome.SUCCESS,
    );

    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]).toEqual({
      actorId: 'actor-1',
      targetId: 'target-1',
      action: AccountDeletionAuditAction.SELF_DELETE_CONFIRMED,
      outcome: AccountDeletionAuditOutcome.SUCCESS,
    });
  });

  it('swallows a repository save failure instead of throwing', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.record(
        'actor-1',
        'target-1',
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.FAILURE,
      ),
    ).resolves.toBeUndefined();
  });
});
