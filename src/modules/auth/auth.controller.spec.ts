import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConfigService } from '@/core/config/config.service';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { SessionService } from './session.service';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    register: jest.fn(),
    confirmByCode: jest.fn(),
    confirmByLink: jest.fn(),
    resendConfirmation: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    verifyLogin: jest.fn(),
    verifyLoginByLink: jest.fn(),
  };

  const passwordResetService = {
    requestReset: jest.fn(),
    confirmReset: jest.fn(),
    exchangeLinkToken: jest.fn(),
  };

  const configService = {
    get: jest.fn().mockReturnValue('test'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: PasswordResetService, useValue: passwordResetService },
        { provide: ConfigService, useValue: configService },
        SessionAuthGuard,
        { provide: SessionService, useValue: { validate: jest.fn() } },
        {
          provide: getRepositoryToken(UserRole),
          useValue: { find: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(AuthController);
  });

  it('delegates register to AuthService', async () => {
    authService.register.mockResolvedValue({
      message: 'ok',
      confirmationRequired: false,
    });

    const req = { ip: '127.0.0.1', headers: {} } as never;
    const result = await controller.register(
      { email: 'a@b.com', password: 'validpass1' },
      req,
    );

    expect(result.confirmationRequired).toBe(false);
    expect(authService.register).toHaveBeenCalled();
  });

  function makeReply() {
    return { setCookie: jest.fn(), clearCookie: jest.fn() };
  }

  const req = { ip: '127.0.0.1', headers: {} } as never;

  it('sets the session cookie when login issues a session', async () => {
    authService.login.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      session: { token: 'raw-token', session: { expiresAt: new Date() } },
    });
    const reply = makeReply();

    const result = await controller.login(
      { email: 'a@b.com', password: 'validpass1' },
      req,
      reply as never,
    );

    expect(result.verificationRequired).toBe(false);
    expect(reply.setCookie).toHaveBeenCalled();
  });

  it('does not set a cookie when login requires verification', async () => {
    authService.login.mockResolvedValue({
      response: { message: 'Enter the code.', verificationRequired: true },
    });
    const reply = makeReply();

    const result = await controller.login(
      { email: 'a@b.com', password: 'validpass1' },
      req,
      reply as never,
    );

    expect(result.verificationRequired).toBe(true);
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('delegates verifyLogin to AuthService and sets the cookie on success', async () => {
    authService.verifyLogin.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      session: { token: 'raw-token', session: { expiresAt: new Date() } },
    });
    const reply = makeReply();

    await controller.verifyLogin(
      { email: 'a@b.com', code: '123456' },
      req,
      reply as never,
    );

    expect(authService.verifyLogin).toHaveBeenCalled();
    expect(reply.setCookie).toHaveBeenCalled();
  });

  it('delegates verifyLoginByLink to AuthService', async () => {
    authService.verifyLoginByLink.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      session: { token: 'raw-token', session: { expiresAt: new Date() } },
    });
    const reply = makeReply();

    await controller.verifyLoginByLink('token-value', req, reply as never);

    expect(authService.verifyLoginByLink).toHaveBeenCalledWith(
      'token-value',
      expect.any(Object),
    );
  });

  it('clears the cookie on logout', async () => {
    authService.logout.mockResolvedValue({ message: 'Signed out.' });
    const reply = makeReply();

    const result = await controller.logout(
      { ip: '127.0.0.1', headers: {}, cookies: { session: 'raw-token' } },
      reply as never,
    );

    expect(result.message).toBe('Signed out.');
    expect(reply.clearCookie).toHaveBeenCalled();
  });

  it('delegates password-reset request to PasswordResetService', async () => {
    passwordResetService.requestReset.mockResolvedValue({ message: 'ok' });

    await controller.requestPasswordReset({ email: 'a@b.com' }, req);

    expect(passwordResetService.requestReset).toHaveBeenCalledWith(
      'a@b.com',
      expect.any(Object),
    );
  });

  it('delegates password-reset confirm to PasswordResetService', async () => {
    passwordResetService.confirmReset.mockResolvedValue({ message: 'ok' });

    await controller.confirmPasswordReset(
      { email: 'a@b.com', code: '123456', newPassword: 'NewPassword1!' },
      req,
    );

    expect(passwordResetService.confirmReset).toHaveBeenCalled();
  });

  it('delegates password-reset link exchange to PasswordResetService', async () => {
    passwordResetService.exchangeLinkToken.mockResolvedValue({
      email: 'a@b.com',
      code: 'token-value',
    });

    const result = await controller.exchangePasswordResetLink('token-value');

    expect(result).toEqual({ email: 'a@b.com', code: 'token-value' });
  });
});
