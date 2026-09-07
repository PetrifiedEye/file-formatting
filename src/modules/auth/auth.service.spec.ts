import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

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
import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';
import { LoginAuditService } from './login-audit.service';
import { SessionService } from './session.service';
import { LoginChallengeService } from './login-challenge.service';
import { hashPassword } from './utils/password-hasher';

describe('AuthService', () => {
  let service: AuthService;

  beforeAll(() => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    addTransactionalDataSource({
      name: 'default',
      // @Transactional() methods only need `.transaction(cb)` here — no real DB.
      dataSource: {
        transaction: (cb: (m: unknown) => unknown) => cb({}),
      } as never,
      patch: false,
    });
  });

  const usersService = {
    findByNormalizedEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    deleteExpiredPendingUsers: jest.fn(),
    activate: jest.fn(),
    updatePendingExpiry: jest.fn(),
    isLockedOut: jest.fn().mockReturnValue(false),
    recordFailedLogin: jest.fn(),
    recordSuccessfulLogin: jest.fn(),
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
    sendLoginVerificationEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
  };

  const loginAuditService = {
    record: jest.fn(),
  };

  const sessionService = {
    issue: jest.fn(),
    validate: jest.fn(),
    invalidate: jest.fn(),
    invalidateAllForUser: jest.fn(),
  };

  const loginChallengeService = {
    issue: jest.fn(),
    verifyByCode: jest.fn(),
    verifyByLinkToken: jest.fn(),
  };

  const defaultSettings = {
    registrationConfirmationEnabled: false,
    signInConfirmationEnabled: false,
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
        { provide: LoginAuditService, useValue: loginAuditService },
        { provide: SessionService, useValue: sessionService },
        { provide: LoginChallengeService, useValue: loginChallengeService },
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

  describe('login', () => {
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword('CorrectHorse123!');
    });

    it('issues a session for correct credentials', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
      };
      usersService.findByNormalizedEmail.mockResolvedValue(user);
      sessionService.issue.mockResolvedValue({
        token: 'raw-token',
        session: { id: 'session-1', expiresAt: new Date() },
      });

      const result = await service.login(
        { email: 'user@example.com', password: 'CorrectHorse123!' },
        { ipAddress: '127.0.0.1' },
      );

      expect(result.response).toEqual({
        message: 'Signed in.',
        verificationRequired: false,
      });
      expect(result.session).toBeDefined();
      expect(sessionService.issue).toHaveBeenCalledWith(
        user,
        '127.0.0.1',
        undefined,
      );
      expect(loginAuditService.record).toHaveBeenCalledWith(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.SUCCESS,
        expect.any(Object),
      );
    });

    it('rejects wrong password with a generic message', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
      });

      await expect(
        service.login(
          { email: 'user@example.com', password: 'wrong-password' },
          {},
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(sessionService.issue).not.toHaveBeenCalled();
      expect(loginAuditService.record).toHaveBeenCalledWith(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.FAILURE,
        expect.objectContaining({ failureReason: 'invalid_credentials' }),
      );
    });

    it('rejects unknown email with the identical outcome as wrong password', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue(null);

      let unknownEmailError: unknown;
      try {
        await service.login(
          { email: 'nobody@example.com', password: 'whatever1' },
          {},
        );
      } catch (error) {
        unknownEmailError = error;
      }

      expect(unknownEmailError).toBeInstanceOf(UnauthorizedException);
      expect(
        (unknownEmailError as UnauthorizedException).getResponse(),
      ).toEqual(
        expect.objectContaining({ message: 'Invalid email or password.' }),
      );
    });

    it('rejects unconfirmed accounts with canResend', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.PENDING_CONFIRMATION,
      });

      let pendingError: unknown;
      try {
        await service.login(
          { email: 'user@example.com', password: 'CorrectHorse123!' },
          {},
        );
      } catch (error) {
        pendingError = error;
      }

      expect(pendingError).toBeInstanceOf(ForbiddenException);
      expect((pendingError as ForbiddenException).getResponse()).toEqual(
        expect.objectContaining({ canResend: true }),
      );
      expect(sessionService.issue).not.toHaveBeenCalled();
    });
  });

  describe('login (sign-in verification enabled)', () => {
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword('CorrectHorse123!');
    });

    beforeEach(() => {
      settingsService.getSettings.mockResolvedValue({
        ...defaultSettings,
        signInConfirmationEnabled: true,
      });
    });

    it('issues a login challenge instead of a session', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
      });
      loginChallengeService.issue.mockResolvedValue({
        challenge: { id: 'challenge-1' },
        tokens: { otp: '123456', linkToken: 'link-token' },
      });

      const result = await service.login(
        { email: 'user@example.com', password: 'CorrectHorse123!' },
        {},
      );

      expect(result.response.verificationRequired).toBe(true);
      expect(result.session).toBeUndefined();
      expect(sessionService.issue).not.toHaveBeenCalled();
      expect(
        confirmationMailService.sendLoginVerificationEmail,
      ).toHaveBeenCalledWith('user@example.com', '123456', 'link-token');
    });
  });

  describe('verifyLogin', () => {
    it('issues a session for a correct code', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      loginChallengeService.verifyByCode.mockResolvedValue({
        ok: true,
        challenge: { userId: 'user-1' },
      });
      sessionService.issue.mockResolvedValue({
        token: 'raw-token',
        session: { id: 'session-1', expiresAt: new Date() },
      });

      const result = await service.verifyLogin({
        email: 'user@example.com',
        code: '123456',
      });

      expect(result.session).toBeDefined();
      expect(result.response.message).toBe('Signed in.');
    });

    it('throws 404 when there is no pending verification', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      loginChallengeService.verifyByCode.mockResolvedValue({
        ok: false,
        reason: 'not_found',
      });

      await expect(
        service.verifyLogin({ email: 'user@example.com', code: '123456' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws generic 400 for a wrong code', async () => {
      usersService.findByNormalizedEmail.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });
      loginChallengeService.verifyByCode.mockResolvedValue({
        ok: false,
        reason: 'wrong_code',
      });

      await expect(
        service.verifyLogin({ email: 'user@example.com', code: '000000' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('login (lockout)', () => {
    let passwordHash: string;

    beforeAll(async () => {
      passwordHash = await hashPassword('CorrectHorse123!');
    });

    it('rejects with 423 when the account is locked, without checking the password', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
        lockedUntil: new Date(Date.now() + 60000),
      };
      usersService.findByNormalizedEmail.mockResolvedValue(user);
      usersService.isLockedOut.mockReturnValueOnce(true);

      let lockedError: unknown;
      try {
        await service.login(
          { email: 'user@example.com', password: 'CorrectHorse123!' },
          {},
        );
      } catch (error) {
        lockedError = error;
      }

      expect(lockedError).toBeInstanceOf(HttpException);
      expect((lockedError as HttpException).getStatus()).toBe(423);
      expect(loginAuditService.record).toHaveBeenCalledWith(
        LoginAuditEventType.LOGIN_ATTEMPT,
        LoginAuditOutcome.LOCKED_OUT,
        expect.objectContaining({ failureReason: 'locked_out' }),
      );
    });

    it('records a failed login attempt on wrong password', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
        lockedUntil: null,
      };
      usersService.findByNormalizedEmail.mockResolvedValue(user);

      await expect(
        service.login(
          { email: 'user@example.com', password: 'wrong-password' },
          {},
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(usersService.recordFailedLogin).toHaveBeenCalledWith(user);
    });

    it('resets lockout counters on a successful login', async () => {
      const user = {
        id: 'user-1',
        email: 'user@example.com',
        passwordHash,
        status: UserStatus.ACTIVE,
        lockedUntil: null,
      };
      usersService.findByNormalizedEmail.mockResolvedValue(user);
      sessionService.issue.mockResolvedValue({
        token: 'raw-token',
        session: { id: 'session-1', expiresAt: new Date() },
      });

      await service.login(
        { email: 'user@example.com', password: 'CorrectHorse123!' },
        {},
      );

      expect(usersService.recordSuccessfulLogin).toHaveBeenCalledWith(user);
    });
  });

  describe('logout', () => {
    it('invalidates the session and logs the outcome', async () => {
      sessionService.validate.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
      });
      usersService.findById.mockResolvedValue({
        id: 'user-1',
        email: 'user@example.com',
      });

      const result = await service.logout('raw-token', {
        ipAddress: '127.0.0.1',
      });

      expect(result.message).toBe('Signed out.');
      expect(sessionService.invalidate).toHaveBeenCalledWith('session-1');
      expect(loginAuditService.record).toHaveBeenCalledWith(
        LoginAuditEventType.LOGOUT,
        LoginAuditOutcome.SUCCESS,
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('is a no-op when there is no valid session', async () => {
      sessionService.validate.mockResolvedValue(null);

      const result = await service.logout('bad-token', {});

      expect(result.message).toBe('Signed out.');
      expect(sessionService.invalidate).not.toHaveBeenCalled();
    });
  });
});
