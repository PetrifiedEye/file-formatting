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

import { PasswordResetChallenge } from './entities/password-reset-challenge.entity';
import { PasswordResetService } from './password-reset.service';
import { LoginAuditService } from './login-audit.service';
import { SessionService } from './session.service';
import { ConfirmationMailService } from './confirmation-mail.service';
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

  const usersService = {
    findByNormalizedEmail: jest.fn(),
    updatePassword: jest.fn(),
  };

  const settingsService = {
    getSettings: jest.fn(),
  };

  const sessionService = {
    invalidateAllForUser: jest.fn(),
  };

  const confirmationMailService = {
    sendPasswordResetEmail: jest.fn(),
  };

  const loginAuditService = {
    record: jest.fn(),
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
        { provide: UsersService, useValue: usersService },
        { provide: SettingsService, useValue: settingsService },
        { provide: SessionService, useValue: sessionService },
        { provide: ConfirmationMailService, useValue: confirmationMailService },
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
    it('applies the new password, invalidates sessions, and consumes the challenge', async () => {
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
      expect(sessionService.invalidateAllForUser).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('rejects a weak new password without touching the challenge', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
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
