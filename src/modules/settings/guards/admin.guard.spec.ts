import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';

import { AdminGuard } from './admin.guard';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let jwtAuthGuard: { canActivate: jest.Mock };
  let accessConfigService: { hasPermission: jest.Mock };
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
    jwtAuthGuard = {
      canActivate: jest.fn().mockResolvedValue(true),
    };
    accessConfigService = {
      hasPermission: jest.fn().mockReturnValue(true),
    };
    guard = new AdminGuard(
      jwtAuthGuard as unknown as JwtAuthGuard,
      accessConfigService as unknown as AccessConfigService,
    );
  });

  it('rejects when there is no valid access token', async () => {
    jwtAuthGuard.canActivate.mockRejectedValue(
      new UnauthorizedException('Authentication required'),
    );

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a valid session without settings:manage', async () => {
    request.user = { id: 'user-1', roles: ['viewer'] };
    accessConfigService.hasPermission.mockReturnValue(false);

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a session whose roles carry settings:manage', async () => {
    request.user = { id: 'user-1', roles: ['admin'] };

    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    expect(accessConfigService.hasPermission).toHaveBeenCalledWith(
      ['admin'],
      'settings',
      'manage',
    );
  });

  it('rejects an admin whose settings grant was revoked', async () => {
    // The old guard tested `roles.includes('admin')`, so a revoked grant left
    // the endpoint wide open to anyone still holding the role.
    request.user = { id: 'user-1', roles: ['admin'] };
    accessConfigService.hasPermission.mockReturnValue(false);

    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
