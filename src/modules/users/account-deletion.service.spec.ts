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
import { LocalFileStorageService } from '@/core/storage/local-file-storage.service';

import { AccountDeletionAuditService } from './account-deletion-audit.service';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionChallenge } from './entities/account-deletion-challenge.entity';
import {
  AccountDeletionAuditAction,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let challengeRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let usersRepository: {
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    manager: { query: jest.Mock };
  };
  let usersService: { toRelativeAssetPath: jest.Mock; deleteUser: jest.Mock };
  let confirmationMailService: { sendAccountDeletionConfirmation: jest.Mock };
  let storageService: { delete: jest.Mock };
  let auditService: { record: jest.Mock };

  const caller = {
    id: 'user-1',
    email: 'user@example.com',
    deletionStartedAt: null,
  } as User;

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
      create: jest.fn((data: Partial<AccountDeletionChallenge>) => data),
      save: jest.fn((c: Partial<AccountDeletionChallenge>) =>
        Promise.resolve({ id: 'challenge-1', ...c }),
      ),
    };
    usersRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneOrFail: jest.fn(),
      manager: { query: jest.fn() },
    };
    usersService = {
      toRelativeAssetPath: jest.fn().mockReturnValue(null),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    confirmationMailService = {
      sendAccountDeletionConfirmation: jest.fn().mockResolvedValue(undefined),
    };
    storageService = { delete: jest.fn().mockResolvedValue(undefined) };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        {
          provide: getRepositoryToken(AccountDeletionChallenge),
          useValue: challengeRepository,
        },
        { provide: getRepositoryToken(User), useValue: usersRepository },
        { provide: UsersService, useValue: usersService },
        {
          provide: ConfirmationMailService,
          useValue: confirmationMailService,
        },
        { provide: LocalFileStorageService, useValue: storageService },
        { provide: AccountDeletionAuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get(AccountDeletionService);
  });

  describe('initiateSelfDelete', () => {
    it('invalidates any prior active challenge, creates a new one, and sends the confirmation email', async () => {
      const priorChallenge = {
        id: 'prior-1',
        userId: caller.id,
        invalidatedAt: null,
        consumedAt: null,
      };
      challengeRepository.findOne.mockResolvedValueOnce(priorChallenge);

      const before = Date.now();
      await service.initiateSelfDelete(caller);

      const anyDate = expect.any(Date) as Date;
      expect(challengeRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'prior-1', invalidatedAt: anyDate }),
      );

      const newChallenge = (
        challengeRepository.save.mock.calls as [
          Partial<AccountDeletionChallenge>,
        ][]
      )
        .map(([arg]) => arg)
        .find((arg) => arg.userId === caller.id && arg.attemptsRemaining === 5);

      expect(newChallenge?.expiresAt?.getTime()).toBeGreaterThan(before);

      expect(
        confirmationMailService.sendAccountDeletionConfirmation,
      ).toHaveBeenCalledWith(
        caller.email,
        expect.any(String),
        expect.any(String),
      );

      expect(auditService.record).toHaveBeenCalledWith(
        caller.id,
        caller.id,
        AccountDeletionAuditAction.SELF_DELETE_INITIATED,
        AccountDeletionAuditOutcome.SUCCESS,
      );
    });

    it('rejects with 409 when the account is already mid-deletion', async () => {
      const claimedCaller = {
        ...caller,
        deletionStartedAt: new Date(),
      } as User;

      await expect(service.initiateSelfDelete(claimedCaller)).rejects.toThrow(
        ConflictException,
      );
      expect(challengeRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('resendSelfDelete', () => {
    it('rejects with 429 before the cooldown elapses', async () => {
      challengeRepository.findOne.mockResolvedValueOnce({
        id: 'challenge-1',
        userId: caller.id,
        lastSentAt: new Date(Date.now() - RESEND_INTERVAL_MS / 2),
      });

      await expect(service.resendSelfDelete(caller)).rejects.toMatchObject({
        status: 429,
      });
    });

    it('rejects with 400 when no active challenge exists', async () => {
      challengeRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.resendSelfDelete(caller)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('confirmSelfDelete', () => {
    function activeChallenge(
      overrides: Partial<AccountDeletionChallenge> = {},
    ) {
      const tokens = {
        otpHash: hashSecret('123456'),
        linkTokenHash: 'link-hash',
      };
      return {
        id: 'challenge-1',
        userId: caller.id,
        otpHash: tokens.otpHash,
        linkTokenHash: tokens.linkTokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
        ...overrides,
      } as AccountDeletionChallenge;
    }

    it('claims the row, deletes the photo file and the user, and records success on the correct code', async () => {
      const challenge = activeChallenge();
      challengeRepository.findOne.mockResolvedValueOnce(challenge);
      usersRepository.manager.query.mockResolvedValueOnce([
        [{ photoUrl: 'https://assets.example.com/assets/photos/a.jpg' }],
        1,
      ]);
      usersService.toRelativeAssetPath.mockReturnValueOnce('photos/a.jpg');
      usersRepository.findOneOrFail.mockResolvedValueOnce({
        id: caller.id,
        photoUrl: 'https://assets.example.com/assets/photos/a.jpg',
      });

      const result = await service.confirmSelfDelete(caller, '123456');

      expect(result.message).toBeDefined();
      expect(challenge.consumedAt).toBeInstanceOf(Date);
      expect(usersService.deleteUser).toHaveBeenCalled();
      expect(storageService.delete).toHaveBeenCalledWith('photos/a.jpg');
      expect(auditService.record).toHaveBeenCalledWith(
        caller.id,
        caller.id,
        AccountDeletionAuditAction.SELF_DELETE_CONFIRMED,
        AccountDeletionAuditOutcome.SUCCESS,
      );
    });

    it('decrements attemptsRemaining and records failure on the wrong code', async () => {
      const challenge = activeChallenge();
      challengeRepository.findOne.mockResolvedValueOnce(challenge);

      await expect(
        service.confirmSelfDelete(caller, 'wrong-code'),
      ).rejects.toThrow(BadRequestException);

      expect(challenge.attemptsRemaining).toBe(4);
      expect(auditService.record).toHaveBeenCalledWith(
        caller.id,
        caller.id,
        AccountDeletionAuditAction.SELF_DELETE_FAILED,
        AccountDeletionAuditOutcome.FAILURE,
      );
      expect(usersRepository.manager.query).not.toHaveBeenCalled();
    });

    it('rejects when no active challenge exists', async () => {
      challengeRepository.findOne.mockResolvedValueOnce(null);

      await expect(service.confirmSelfDelete(caller, '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when the challenge is expired', async () => {
      const challenge = activeChallenge({
        expiresAt: new Date(Date.now() - 1000),
      });
      challengeRepository.findOne.mockResolvedValueOnce(challenge);

      await expect(service.confirmSelfDelete(caller, '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when attempts are exhausted', async () => {
      const challenge = activeChallenge({ attemptsRemaining: 0 });
      challengeRepository.findOne.mockResolvedValueOnce(challenge);

      await expect(service.confirmSelfDelete(caller, '123456')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects with 409 when the row is already claimed by a concurrent deletion', async () => {
      const challenge = activeChallenge();
      challengeRepository.findOne.mockResolvedValueOnce(challenge);
      usersRepository.manager.query.mockResolvedValueOnce([[], 0]);
      usersRepository.findOne.mockResolvedValueOnce({ id: caller.id });

      await expect(service.confirmSelfDelete(caller, '123456')).rejects.toThrow(
        ConflictException,
      );

      expect(auditService.record).toHaveBeenCalledWith(
        caller.id,
        caller.id,
        AccountDeletionAuditAction.SELF_DELETE_FAILED,
        AccountDeletionAuditOutcome.CONFLICT,
      );
    });
  });

  describe('adminDelete', () => {
    it('claims and deletes the target, including its photo file', async () => {
      usersRepository.manager.query.mockResolvedValueOnce([
        [{ photoUrl: 'https://assets.example.com/assets/photos/b.jpg' }],
        1,
      ]);
      usersService.toRelativeAssetPath.mockReturnValueOnce('photos/b.jpg');
      usersRepository.findOneOrFail.mockResolvedValueOnce({
        id: 'target-1',
        photoUrl: 'https://assets.example.com/assets/photos/b.jpg',
      });

      const result = await service.adminDelete('target-1');

      expect(result).toEqual({ message: 'deleted', outcome: 'deleted' });
      expect(usersService.deleteUser).toHaveBeenCalled();
      expect(storageService.delete).toHaveBeenCalledWith('photos/b.jpg');
    });

    it('returns an idempotent already-removed result for a target with no matching row', async () => {
      usersRepository.manager.query.mockResolvedValueOnce([[], 0]);
      usersRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.adminDelete('never-existed');

      expect(result).toEqual({
        message: 'already removed',
        outcome: 'already_removed',
      });
      expect(usersService.deleteUser).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the target is already mid-deletion', async () => {
      usersRepository.manager.query.mockResolvedValueOnce([[], 0]);
      usersRepository.findOne.mockResolvedValueOnce({ id: 'target-1' });

      await expect(service.adminDelete('target-1')).rejects.toThrow(
        ConflictException,
      );
      expect(usersService.deleteUser).not.toHaveBeenCalled();
    });
  });
});
