import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';

import { ConfirmationChallenge } from '@/modules/auth/entities/confirmation-challenge.entity';
import { CONFIRMATION_TTL_MS } from '@/modules/auth/utils/confirmation-token';

import { ConfirmationChallengeService } from './confirmation-challenge.service';

describe('ConfirmationChallengeService', () => {
  let service: ConfirmationChallengeService;
  let repository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: Partial<ConfirmationChallenge>) => data),
      save: jest.fn((challenge: Partial<ConfirmationChallenge>) =>
        Promise.resolve(challenge),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfirmationChallengeService,
        {
          provide: getRepositoryToken(ConfirmationChallenge),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get(ConfirmationChallengeService);
  });

  it('treats only an unconsumed, uninvalidated challenge as active', async () => {
    await service.findActiveByUserId('user-1');

    const [{ where }] = repository.findOne.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where.userId).toBe('user-1');
    expect((where.invalidatedAt as FindOperator<unknown>).type).toBe('isNull');
    expect((where.consumedAt as FindOperator<unknown>).type).toBe('isNull');
  });

  it('loads the user with a challenge found by its link token', async () => {
    await service.findByLinkTokenHash('hash');

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { linkTokenHash: 'hash' },
      relations: ['user'],
    });
  });

  it('invalidates the active challenge, and does nothing when there is none', async () => {
    await service.invalidateActiveForUser('user-1');
    expect(repository.save).not.toHaveBeenCalled();

    const active = { id: 'c-1', invalidatedAt: null };
    repository.findOne.mockResolvedValue(active);

    await service.invalidateActiveForUser('user-1');

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'c-1',
        invalidatedAt: expect.any(Date) as Date,
      }),
    );
  });

  it('replaces any active challenge with a fresh one', async () => {
    const previous = { id: 'c-old', invalidatedAt: null };
    repository.findOne.mockResolvedValueOnce(previous);
    const lastSentAt = new Date('2026-09-28T10:00:00.000Z');

    const created = await service.createChallenge({
      userId: 'user-1',
      tokens: {
        otp: '123456',
        otpHash: 'otp-hash',
        linkToken: 'link',
        linkTokenHash: 'link-hash',
      },
      lastSentAt,
    });

    // The old one first, so there is never more than one active challenge.
    expect((repository.save.mock.calls as unknown[][])[0][0]).toMatchObject({
      id: 'c-old',
      invalidatedAt: expect.any(Date) as Date,
    });
    expect(created).toEqual({
      userId: 'user-1',
      otpHash: 'otp-hash',
      linkTokenHash: 'link-hash',
      issuedAt: lastSentAt,
      expiresAt: new Date(lastSentAt.getTime() + CONFIRMATION_TTL_MS),
      attemptsRemaining: 5,
      lastSentAt,
    });
  });
});
