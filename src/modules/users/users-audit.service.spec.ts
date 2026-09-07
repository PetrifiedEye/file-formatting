import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  UserProfileAuditEvent,
  UserProfileAuditOutcome,
} from './entities/user-profile-audit-event.entity';
import { UsersAuditService } from './users-audit.service';

describe('UsersAuditService', () => {
  let service: UsersAuditService;
  const savedEvents: Partial<UserProfileAuditEvent>[] = [];

  const repository = {
    create: jest.fn((data: Partial<UserProfileAuditEvent>) => data),
    save: jest.fn((event: Partial<UserProfileAuditEvent>) => {
      savedEvents.push(event);
      return Promise.resolve(event);
    }),
  };

  beforeEach(async () => {
    savedEvents.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersAuditService,
        {
          provide: getRepositoryToken(UserProfileAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(UsersAuditService);
  });

  it('creates and saves an audit row with the given viewer/target/outcome', async () => {
    await service.record(
      'viewer-1',
      'target-1',
      UserProfileAuditOutcome.SELF_VIEW,
    );

    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]).toEqual({
      viewerId: 'viewer-1',
      targetId: 'target-1',
      outcome: UserProfileAuditOutcome.SELF_VIEW,
    });
  });

  it('swallows a repository save failure instead of throwing', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.record('viewer-1', 'target-1', UserProfileAuditOutcome.DENIED),
    ).resolves.toBeUndefined();
  });
});
