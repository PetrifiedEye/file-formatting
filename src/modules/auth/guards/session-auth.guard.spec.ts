import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UserRole } from '@/modules/rbac/entities/user-role.entity';

import { SessionService } from '../session.service';
import { SessionAuthGuard } from './session-auth.guard';

describe('SessionAuthGuard', () => {
  let guard: SessionAuthGuard;

  const sessionService = { validate: jest.fn() };
  const userRoleRepository = { find: jest.fn() };

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
        SessionAuthGuard,
        { provide: SessionService, useValue: sessionService },
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepository },
      ],
    }).compile();

    guard = module.get(SessionAuthGuard);
  });

  it('rejects when no session cookie is present', async () => {
    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionService.validate).not.toHaveBeenCalled();
  });

  it('rejects when the session is invalid, expired, or invalidated', async () => {
    sessionService.validate.mockResolvedValue(null);

    await expect(
      guard.canActivate(buildContext({ session: 'bad-token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('populates request.user with id and roles for a valid session', async () => {
    sessionService.validate.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
    });
    userRoleRepository.find.mockResolvedValue([
      { role: { name: 'admin' } },
      { role: { name: 'editor' } },
    ]);

    const request: { cookies: Record<string, string>; user?: unknown } = {
      cookies: { session: 'good-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      roles: ['admin', 'editor'],
    });
  });
});
