import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import { SessionAuthGuard } from '@/modules/auth/guards/session-auth.guard';

import { AdminGuard } from './admin.guard';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let sessionAuthGuard: { canActivate: jest.Mock };
  let request: { user?: { id: string; roles: string[] } };

  function makeContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    request = {};
    sessionAuthGuard = {
      canActivate: jest.fn().mockResolvedValue(true),
    };
    guard = new AdminGuard(sessionAuthGuard as unknown as SessionAuthGuard);
  });

  it('rejects when there is no valid session', async () => {
    sessionAuthGuard.canActivate.mockRejectedValue(
      new UnauthorizedException('Authentication required'),
    );

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a valid session without the admin role', async () => {
    request.user = { id: 'user-1', roles: ['viewer'] };

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a valid session with the admin role', async () => {
    request.user = { id: 'user-1', roles: ['admin'] };

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });
});
