import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { User, UserStatus } from '@/modules/users/entities/user.entity';

import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from '../entities/login-audit-event.entity';
import { LoginAuditService } from '../login-audit.service';
import { TokenService, TokenVerificationError } from '../token.service';
import { AuthSessionService } from '../auth-session.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;

  const tokenService = { verifyAccessToken: jest.fn() };
  const loginAuditService = { record: jest.fn() };
  const userRepository = { findOne: jest.fn() };
  const userRoleRepository = { find: jest.fn() };
  const sessionService = { findActive: jest.fn() };

  const buildContext = (cookies?: Record<string, string>): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ cookies }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: TokenService, useValue: tokenService },
        { provide: LoginAuditService, useValue: loginAuditService },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepository },
        { provide: AuthSessionService, useValue: sessionService },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    sessionService.findActive.mockResolvedValue({ id: 'session-1' });
  });

  it('rejects and audits when no access token cookie is present', async () => {
    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(tokenService.verifyAccessToken).not.toHaveBeenCalled();
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'missing' }),
    );
  });

  it('rejects and audits a malformed token', async () => {
    tokenService.verifyAccessToken.mockRejectedValue(
      new TokenVerificationError('malformed'),
    );

    await expect(
      guard.canActivate(buildContext({ access_token: 'garbage' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'malformed' }),
    );
  });

  it('rejects and audits a token with a bad signature', async () => {
    tokenService.verifyAccessToken.mockRejectedValue(
      new TokenVerificationError('invalid_signature'),
    );

    await expect(
      guard.canActivate(buildContext({ access_token: 'tampered' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'invalid_signature' }),
    );
  });

  it('rejects and audits an expired token', async () => {
    tokenService.verifyAccessToken.mockRejectedValue(
      new TokenVerificationError('expired'),
    );

    await expect(
      guard.canActivate(buildContext({ access_token: 'expired' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'expired' }),
    );
  });

  it('rejects and audits when the user no longer exists', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      sessionId: 'session-1',
    });
    userRepository.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(buildContext({ access_token: 'good-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'user_not_found' }),
    );
  });

  it('rejects and audits when the user is not active', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      sessionId: 'session-1',
    });
    userRepository.findOne.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.PENDING_CONFIRMATION,
    });

    await expect(
      guard.canActivate(buildContext({ access_token: 'good-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'user_inactive' }),
    );
  });

  it('populates request.user with id and roles for a valid token', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      sessionId: 'session-1',
    });
    userRepository.findOne.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.ACTIVE,
    });
    userRoleRepository.find.mockResolvedValue([
      { role: { name: 'admin' } },
      { role: { name: 'editor' } },
    ]);

    const request: {
      cookies: Record<string, string>;
      user?: unknown;
    } = {
      cookies: { access_token: 'good-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      roles: ['admin', 'editor'],
    });
    expect(loginAuditService.record).not.toHaveBeenCalled();
  });

  it('rejects and audits a token whose session was revoked', async () => {
    tokenService.verifyAccessToken.mockResolvedValue({
      sub: 'user-1',
      sessionId: 'session-1',
    });
    userRepository.findOne.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.ACTIVE,
    });
    // Logout and password reset revoke the session; the still-unexpired access
    // token must stop working at that moment.
    sessionService.findActive.mockResolvedValue(null);

    await expect(
      guard.canActivate(buildContext({ access_token: 'good-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loginAuditService.record).toHaveBeenCalledWith(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      expect.objectContaining({ failureReason: 'session_revoked' }),
    );
  });
});
