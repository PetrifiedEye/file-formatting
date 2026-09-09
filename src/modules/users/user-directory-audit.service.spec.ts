import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  UserDirectoryAuditEvent,
  UserDirectoryAuditOutcome,
} from './entities/user-directory-audit-event.entity';
import { UserDirectoryAuditService } from './user-directory-audit.service';

describe('UserDirectoryAuditService', () => {
  let service: UserDirectoryAuditService;
  const savedEvents: Partial<UserDirectoryAuditEvent>[] = [];

  const repository = {
    create: jest.fn((data: Partial<UserDirectoryAuditEvent>) => data),
    save: jest.fn((event: Partial<UserDirectoryAuditEvent>) => {
      savedEvents.push(event);
      return Promise.resolve(event);
    }),
  };

  beforeEach(async () => {
    savedEvents.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserDirectoryAuditService,
        {
          provide: getRepositoryToken(UserDirectoryAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(UserDirectoryAuditService);
  });

  it('persists actor, outcome, resultCount, and option-kind flags with no PII fields', async () => {
    await service.record({
      actorId: 'actor-1',
      outcome: UserDirectoryAuditOutcome.SUCCESS,
      resultCount: 20,
      searchUsed: true,
      statusFilterUsed: false,
      sortField: 'createdAt',
    });

    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]).toEqual({
      actorId: 'actor-1',
      outcome: UserDirectoryAuditOutcome.SUCCESS,
      resultCount: 20,
      searchUsed: true,
      statusFilterUsed: false,
      sortField: 'createdAt',
    });
  });

  it('defaults optional fields to null when omitted', async () => {
    await service.record({
      actorId: null,
      outcome: UserDirectoryAuditOutcome.UNAUTHENTICATED,
    });

    expect(savedEvents[0]).toEqual({
      actorId: null,
      outcome: UserDirectoryAuditOutcome.UNAUTHENTICATED,
      resultCount: null,
      searchUsed: null,
      statusFilterUsed: null,
      sortField: null,
    });
  });

  it('swallows a repository save failure instead of throwing', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.record({
        actorId: 'actor-1',
        outcome: UserDirectoryAuditOutcome.DENIED,
      }),
    ).resolves.toBeUndefined();
  });
});
