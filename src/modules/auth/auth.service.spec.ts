import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { UserStatus } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { AuthService } from './auth.service';
import { ConfirmationChallengeService } from './confirmation-challenge.service';
import { ConfirmationMailService } from './confirmation-mail.service';
import {
  RegistrationAuditEventType,
  RegistrationAuditOutcome,
} from './entities/registration-audit-event.entity';
import { RegistrationAuditService } from './registration-audit.service';

describe('AuthService', () => {
  let service: AuthService;

  const usersService = {
    findByNormalizedEmail: jest.fn(),
    create: jest.fn(),
    deleteExpiredPendingUsers: jest.fn(),
    activate: jest.fn(),
    updatePendingExpiry: jest.fn(),
  };

  const settingsService = {
    getSettings: jest.fn(),
  };

  const auditService = {
    record: jest.fn(),
    countConfirmationEmailsSince: jest.fn().mockResolvedValue(0),
  };

  const challengeService = {
    findActiveByUserId: jest.fn(),
    findActiveByLinkTokenHash: jest.fn(),
    createChallenge: jest.fn(),
    save: jest.fn(),
  };

  const confirmationMailService = {
    sendConfirmationEmail: jest.fn(),
  };

  const defaultSettings = {
    registrationConfirmationEnabled: false,
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
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: SettingsService, useValue: settingsService },
        { provide: RegistrationAuditService, useValue: auditService },
        { provide: ConfirmationChallengeService, useValue: challengeService },
        { provide: ConfirmationMailService, useValue: confirmationMailService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('register (confirmation off)', () => {
    it('creates an active user on success', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({
        id: 'user-1',
        email: 'new@example.com',
        status: UserStatus.ACTIVE,
      });

      const result = await service.register(
        { email: 'new@example.com', password: 'validpass1' },
        { ipAddress: '127.0.0.1' },
      );

      expect(result.confirmationRequired).toBe(false);
      expect(usersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: UserStatus.ACTIVE }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        RegistrationAuditEventType.REGISTRATION_ATTEMPT,
        RegistrationAuditOutcome.SUCCESS,
        expect.any(Object),
      );
    });

    it('returns generic response for duplicate active email', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'existing',
        status: UserStatus.ACTIVE,
      });

      const result = await service.register(
        { email: 'existing@example.com', password: 'validpass1' },
        {},
      );

      expect(result.message).toContain('eligible');
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('throws on invalid password', async () => {
      await expect(
        service.register({ email: 'a@b.com', password: 'short' }, {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('register (confirmation on)', () => {
    beforeEach(() => {
      settingsService.getSettings.mockResolvedValue({
        ...defaultSettings,
        registrationConfirmationEnabled: true,
      });
    });

    it('creates pending user and sends confirmation email', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue({
        id: 'user-1',
        email: 'confirm@example.com',
        status: UserStatus.PENDING_CONFIRMATION,
      });
      challengeService.createChallenge.mockResolvedValue({ id: 'ch-1' });

      const result = await service.register(
        { email: 'confirm@example.com', password: 'validpass1' },
        {},
      );

      expect(result.confirmationRequired).toBe(true);
      expect(confirmationMailService.sendConfirmationEmail).toHaveBeenCalled();
    });

    it('does not send mail on invalid password', async () => {
      await expect(
        service.register({ email: 'a@b.com', password: 'short' }, {}),
      ).rejects.toThrow(BadRequestException);

      expect(
        confirmationMailService.sendConfirmationEmail,
      ).not.toHaveBeenCalled();
    });
  });

  describe('resendConfirmation', () => {
    it('returns generic message when confirmation is disabled', async () => {
      const result = await service.resendConfirmation({ email: 'a@b.com' }, {});

      expect(result.message).toContain('pending registration');
      expect(
        confirmationMailService.sendConfirmationEmail,
      ).not.toHaveBeenCalled();
    });

    it('returns generic message when no pending user exists', async () => {
      settingsService.getSettings.mockResolvedValue({
        ...defaultSettings,
        registrationConfirmationEnabled: true,
      });
      usersService.findByNormalizedEmail.mockResolvedValue(null);

      const result = await service.resendConfirmation(
        { email: 'missing@example.com' },
        {},
      );

      expect(result.message).toContain('pending registration');
    });
  });
});
