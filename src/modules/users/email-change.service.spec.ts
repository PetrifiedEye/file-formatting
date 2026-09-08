import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { ConfirmationMailService } from '@/modules/auth/confirmation-mail.service';
import {
  RESEND_INTERVAL_MS,
  hashSecret,
} from '@/modules/auth/utils/confirmation-token';

import { EmailChangeChallenge } from './entities/email-change-challenge.entity';
import { User } from './entities/user.entity';
import { EmailChangeService } from './email-change.service';
import { ProfileAuditService } from './profile-audit.service';
import { UsersService } from './users.service';

describe('EmailChangeService', () => {
  let service: EmailChangeService;
  let challengeRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let usersRepository: { findOne: jest.Mock; save: jest.Mock };
  let usersService: { findById: jest.Mock };
  let confirmationMailService: { sendEmailChangeConfirmation: jest.Mock };
  let profileAuditService: { record: jest.Mock };

  const caller = { id: 'user-1', email: 'old@example.com' } as User;

  beforeAll(() => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    addTransactionalDataSource({
      name: 'default',
      dataSource: {
        transaction: (cb: (m: unknown) => unknown) => cb({}),
      } as never,
      patch: false,
    });
  });

  beforeEach(async () => {
    challengeRepository = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<EmailChangeChallenge>) => data),
      save: jest.fn((c: Partial<EmailChangeChallenge>) =>
        Promise.resolve({ id: 'challenge-1', ...c }),
      ),
    };
    usersRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((u: Partial<User>) => Promise.resolve(u)),
    };
    usersService = { findById: jest.fn() };
    confirmationMailService = {
      sendEmailChangeConfirmation: jest.fn().mockResolvedValue(undefined),
    };
    profileAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailChangeService,
        {
          provide: getRepositoryToken(EmailChangeChallenge),
          useValue: challengeRepository,
        },
        { provide: getRepositoryToken(User), useValue: usersRepository },
        { provide: UsersService, useValue: usersService },
        {
          provide: ConfirmationMailService,
          useValue: confirmationMailService,
        },
        { provide: ProfileAuditService, useValue: profileAuditService },
      ],
    }).compile();

    service = module.get(EmailChangeService);
  });

  describe('initiate', () => {
    it('invalidates a prior active challenge and creates a new one', async () => {
      const priorChallenge = {
        id: 'prior-1',
        userId: 'user-1',
        invalidatedAt: null,
        consumedAt: null,
      };
      challengeRepository.findOne.mockResolvedValueOnce(priorChallenge);

      const result = await service.initiate(caller, 'new@example.com');

      const anyDate = expect.any(Date) as Date;
      expect(challengeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ invalidatedAt: anyDate }),
      );
      expect(challengeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          newEmail: 'new@example.com',
          attemptsRemaining: 5,
        }),
      );
      expect(
        confirmationMailService.sendEmailChangeConfirmation,
      ).toHaveBeenCalled();
      expect(result.message).toBeDefined();
    });

    it('rejects when newEmail is already used by another account', async () => {
      usersRepository.findOne.mockResolvedValueOnce({
        id: 'other-user',
        email: 'new@example.com',
      });

      await expect(
        service.initiate(caller, 'new@example.com'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(challengeRepository.save).not.toHaveBeenCalled();
    });

    it('creates a challenge with the correct TTL and attempt count', async () => {
      challengeRepository.findOne.mockResolvedValueOnce(null);

      const before = Date.now();
      await service.initiate(caller, 'new@example.com');

      const savedChallenge = (
        challengeRepository.save.mock.calls as [Partial<EmailChangeChallenge>][]
      )
        .map(([arg]) => arg)
        .find((arg) => arg.newEmail === 'new@example.com');

      expect(savedChallenge?.attemptsRemaining).toBe(5);
      expect(savedChallenge?.expiresAt?.getTime()).toBeGreaterThan(before);
    });
  });

  describe('resend', () => {
    it('enforces the resend cooldown', async () => {
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        lastSentAt: new Date(),
        invalidatedAt: null,
        consumedAt: null,
      });

      const error = await service.resend(caller).catch((err: unknown) => err);
      expect(error).toMatchObject({ status: 429 });
    });

    it('rejects when there is no active challenge', async () => {
      challengeRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.resend(caller)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('issues a new code when the cooldown has elapsed', async () => {
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        lastSentAt: new Date(Date.now() - RESEND_INTERVAL_MS - 1000),
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.resend(caller);

      expect(
        confirmationMailService.sendEmailChangeConfirmation,
      ).toHaveBeenCalled();
      expect(result.message).toBeDefined();
    });
  });

  describe('confirm', () => {
    it('updates the email and consumes the challenge on success', async () => {
      const code = '123456';
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        otpHash: hashSecret(code),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.confirm(caller, code);

      expect(result.email).toBe('new@example.com');
      const anyDate = expect.any(Date) as Date;
      expect(challengeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ consumedAt: anyDate }),
      );
    });

    it('decrements attempts_remaining on a wrong code', async () => {
      const challenge = {
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      };
      challengeRepository.findOne.mockResolvedValueOnce(challenge);

      await expect(
        service.confirm(caller, 'wrong-code'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(challengeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ attemptsRemaining: 4 }),
      );
    });

    it('rejects an expired challenge', async () => {
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() - 1000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      await expect(service.confirm(caller, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects when attempts are exhausted', async () => {
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 0,
        invalidatedAt: null,
        consumedAt: null,
      });

      await expect(service.confirm(caller, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects when there is no active challenge', async () => {
      challengeRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.confirm(caller, '123456')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('re-checks email uniqueness at confirm time (race close)', async () => {
      const code = '123456';
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: 'user-1',
        newEmail: 'new@example.com',
        otpHash: hashSecret(code),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });
      usersRepository.findOne.mockResolvedValueOnce({
        id: 'other-user',
        email: 'new@example.com',
      });

      await expect(service.confirm(caller, code)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
