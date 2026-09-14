import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { SettingsService } from '@/modules/settings/settings.service';

import { AccountDeletionChallenge } from '@/modules/users/entities/account-deletion-challenge.entity';
import { EmailChangeChallenge } from '@/modules/users/entities/email-change-challenge.entity';

import { ConfirmationChallenge } from './entities/confirmation-challenge.entity';
import { LoginChallenge } from './entities/login-challenge.entity';
import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PasswordResetService } from './password-reset.service';
import { LoginAuditService } from './login-audit.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import { AuthSessionService } from './auth-session.service';
import { SessionRevocationReason } from './entities/auth-session.entity';
import { hashSecret } from './utils/confirmation-token';

describe('PasswordResetService', () => {
  let service: PasswordResetService;

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

  const challengeRepository = {
    findOne: jest.fn(),
    create: jest.fn((data: Partial<PasswordResetChallenge>) => data),
    save: jest.fn((c: Partial<PasswordResetChallenge>) =>
      Promise.resolve({ id: 'challenge-1', ...c }),
    ),
  };

  /** The other challenge tables a reset has to sweep. */
  const otherChallengeRepository = (): { update: jest.Mock } => ({
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  });
  const loginChallengeRepository = otherChallengeRepository();
  const confirmationChallengeRepository = otherChallengeRepository();
  const emailChangeChallengeRepository = otherChallengeRepository();
  const accountDeletionChallengeRepository = otherChallengeRepository();

  const usersService = {
    findByNormalizedEmail: jest.fn(),
    updatePassword: jest.fn(),
  };

  const settingsService = {
    getSettings: jest.fn(),
  };

  const confirmationMailService = {
    sendPasswordResetEmail: jest.fn(),
  };

  const loginAuditService = {
    record: jest.fn(),
  };

  const sessionService = {
    revokeAllForUser: jest.fn().mockResolvedValue(1),
  };

  const defaultSettings = {
    passwordRecoveryConfirmationEnabled: true,
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireDigit: false,
    passwordRequireSpecial: false,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    settingsService.getSettings.mockResolvedValue(defaultSettings);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        {
          provide: getRepositoryToken(PasswordResetChallenge),
          useValue: challengeRepository,
        },
        {
          provide: getRepositoryToken(LoginChallenge),
          useValue: loginChallengeRepository,
        },
        {
          provide: getRepositoryToken(ConfirmationChallenge),
          useValue: confirmationChallengeRepository,
        },
        {
          provide: getRepositoryToken(EmailChangeChallenge),
          useValue: emailChangeChallengeRepository,
        },
        {
          provide: getRepositoryToken(AccountDeletionChallenge),
          useValue: accountDeletionChallengeRepository,
        },
        { provide: UsersService, useValue: usersService },
        { provide: SettingsService, useValue: settingsService },
        { provide: ConfirmationMailService, useValue: confirmationMailService },
        { provide: AuthSessionService, useValue: sessionService },
        { provide: LoginAuditService, useValue: loginAuditService },
      ],
    }).compile();

    service = module.get(PasswordResetService);
  });

  describe('requestReset', () => {
    it('returns the generic message and no-ops when the kill-switch is off', async () => {
      settingsService.getSettings.mockResolvedValue({
        ...defaultSettings,
        passwordRecoveryConfirmationEnabled: false,
      });

      const result = await service.requestReset('user@example.com', {});

      expect(result.message).toContain('If this email is registered');
      expect(
        confirmationMailService.sendPasswordResetEmail,
      ).not.toHaveBeenCalled();
    });

    it('returns the generic message without leaking unknown emails', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue(null);

      const result = await service.requestReset('nobody@example.com', {});

      expect(result.message).toContain('If this email is registered');
      expect(
        confirmationMailService.sendPasswordResetEmail,
      ).not.toHaveBeenCalled();
    });

    it('issues a challenge and sends the email for a known active user', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        status: UserStatus.ACTIVE,
      });

      const result = await service.requestReset('user@example.com', {});

      expect(result.message).toContain('If this email is registered');
      expect(confirmationMailService.sendPasswordResetEmail).toHaveBeenCalled();
      expect(loginAuditService.record).toHaveBeenCalled();
    });
  });

  describe('confirmReset', () => {
    it('applies the new password and consumes the challenge', async () => {
      const code = '123456';
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      challengeRepository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret(code),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      const result = await service.confirmReset(
        { email: 'user@example.com', code, newPassword: 'NewPassword1!' },
        {},
      );

      expect(result.message).toContain('reset');
      expect(usersService.updatePassword).toHaveBeenCalled();
      // A reset must not leave 30-day refresh tokens minted with the old
      // password alive.
      expect(sessionService.revokeAllForUser).toHaveBeenCalledWith(
        'user-1',
        SessionRevocationReason.PASSWORD_RESET,
      );

      // Nor a code already in the attacker's hands for some *other* flow: an
      // email change or an account deletion held from before the reset could
      // still be redeemed afterwards.
      for (const repository of [
        loginChallengeRepository,
        confirmationChallengeRepository,
        emailChangeChallengeRepository,
        accountDeletionChallengeRepository,
      ]) {
        const [where, patch] = repository.update.mock.calls[0] as [
          { userId: string },
          { invalidatedAt: Date },
        ];
        expect(where.userId).toBe('user-1');
        expect(patch.invalidatedAt).toBeInstanceOf(Date);
      }
    });

    it('does not report password policy errors before the code is verified', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      challengeRepository.findOne.mockResolvedValue(null);

      // Policy errors used to be raised before the challenge was looked at, so
      // a weak password told the caller whether the address was registered:
      // a detailed error list for a known email, the generic message for an
      // unknown one.
      let error: unknown;
      try {
        await service.confirmReset(
          { email: 'user@example.com', code: '123456', newPassword: 'short' },
          {},
        );
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message:
          'Unable to reset password. Please check your code or request a new one.',
      });
    });

    it('rejects a weak new password without touching the challenge', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      challengeRepository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        linkTokenHash: hashSecret('link-token'),
        expiresAt: new Date(Date.now() + 60000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      await expect(
        service.confirmReset(
          { email: 'user@example.com', code: '123456', newPassword: 'short' },
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('rejects an expired challenge', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      challengeRepository.findOne.mockResolvedValue({
        id: 'challenge-1',
        userId: 'user-1',
        otpHash: hashSecret('123456'),
        expiresAt: new Date(Date.now() - 1000),
        attemptsRemaining: 5,
        invalidatedAt: null,
        consumedAt: null,
      });

      await expect(
        service.confirmReset(
          {
            email: 'user@example.com',
            code: '123456',
            newPassword: 'NewPassword1!',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('rejects a reused (already-consumed) challenge', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      challengeRepository.findOne.mockResolvedValue(null);

      await expect(
        service.confirmReset(
          {
            email: 'user@example.com',
            code: '123456',
            newPassword: 'NewPassword1!',
          },
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
