import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ProfileAuditAction,
  ProfileAuditEvent,
  ProfileAuditOutcome,
} from './entities/profile-audit-event.entity';
import { ProfileAuditService } from './profile-audit.service';

describe('ProfileAuditService', () => {
  let service: ProfileAuditService;
  let repository: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((data: Partial<ProfileAuditEvent>) => data),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileAuditService,
        {
          provide: getRepositoryToken(ProfileAuditEvent),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(ProfileAuditService);
  });

  it('persists a row with the given fields', async () => {
    await service.record(
      'actor-1',
      'target-1',
      ProfileAuditAction.PROFILE_UPDATE,
      ProfileAuditOutcome.SUCCESS,
      ['photo'],
    );

    expect(repository.create).toHaveBeenCalledWith({
      actorId: 'actor-1',
      targetId: 'target-1',
      action: ProfileAuditAction.PROFILE_UPDATE,
      outcome: ProfileAuditOutcome.SUCCESS,
      fields: ['photo'],
    });
    expect(repository.save).toHaveBeenCalled();
  });

  it('swallows write failures and does not throw', async () => {
    repository.save.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.record(
        'actor-1',
        'target-1',
        ProfileAuditAction.PROFILE_UPDATE,
        ProfileAuditOutcome.FAILURE,
        ['photo'],
      ),
    ).resolves.toBeUndefined();
  });
});
