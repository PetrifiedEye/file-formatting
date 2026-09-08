import { Test, TestingModule } from '@nestjs/testing';

import { ConfigService } from '@/core/config/config.service';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';

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
    refresh: jest.fn(),
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
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

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

  it('sets both auth cookies when login issues tokens', async () => {
    authService.login.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    });
    const reply = makeReply();

    const result = await controller.login(
      { email: 'a@b.com', password: 'validpass1' },
      req,
      reply as never,
    );

    expect(result.verificationRequired).toBe(false);
    expect(reply.setCookie).toHaveBeenCalledTimes(2);
    expect(reply.setCookie).toHaveBeenCalledWith(
      'access_token',
      'access-token',
      expect.any(Object),
    );
    expect(reply.setCookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-token',
      expect.any(Object),
    );
  });

  it('does not set cookies when login requires verification', async () => {
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

  it('delegates verifyLogin to AuthService and sets cookies on success', async () => {
    authService.verifyLogin.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    });
    const reply = makeReply();

    await controller.verifyLogin(
      { email: 'a@b.com', code: '123456' },
      req,
      reply as never,
    );

    expect(authService.verifyLogin).toHaveBeenCalled();
    expect(reply.setCookie).toHaveBeenCalledTimes(2);
  });

  it('delegates verifyLoginByLink to AuthService', async () => {
    authService.verifyLoginByLink.mockResolvedValue({
      response: { message: 'Signed in.', verificationRequired: false },
      tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    });
    const reply = makeReply();

    await controller.verifyLoginByLink('token-value', req, reply as never);

    expect(authService.verifyLoginByLink).toHaveBeenCalledWith(
      'token-value',
      expect.any(Object),
    );
  });

  it('delegates refresh to AuthService and sets both cookies', async () => {
    authService.refresh.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    const reply = makeReply();

    const result = await controller.refresh(
      { ip: '127.0.0.1', headers: {}, cookies: { refresh_token: 'raw-rt' } },
      reply as never,
    );

    expect(result).toEqual({ message: 'Session refreshed.' });
    expect(authService.refresh).toHaveBeenCalledWith(
      'raw-rt',
      expect.any(Object),
    );
    expect(reply.setCookie).toHaveBeenCalledTimes(2);
  });

  it('clears both cookies on logout without requiring auth', () => {
    authService.logout.mockReturnValue({ message: 'Signed out.' });
    const reply = makeReply();

    const result = controller.logout(reply as never);

    expect(result.message).toBe('Signed out.');
    expect(authService.logout).toHaveBeenCalledWith();
    expect(reply.clearCookie).toHaveBeenCalledTimes(2);
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.any(Object),
    );
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.any(Object),
    );
  });

  it('returns the caller id and roles from the request', () => {
    const request = { user: { id: 'user-1', roles: ['admin'] } } as never;

    expect(controller.getSession(request)).toEqual({
      id: 'user-1',
      roles: ['admin'],
    });
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
