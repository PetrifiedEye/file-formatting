import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { AccessConfigService } from '../access-config.service';
import {
  RbacAuditEventType,
  RbacAuditOutcome,
} from '../entities/rbac-audit-event.entity';
import { RbacAuditService } from '../rbac-audit.service';
import { PermissionGuard, RequestUser } from './permission.guard';

describe('PermissionGuard', () => {
  let guard: PermissionGuard;
  let reflector: Reflector;

  const accessConfigService = { hasPermission: jest.fn() };
  const rbacAuditService = { record: jest.fn().mockResolvedValue(undefined) };

  const buildContext = (user?: RequestUser): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        Reflector,
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: RbacAuditService, useValue: rbacAuditService },
      ],
    }).compile();

    guard = module.get(PermissionGuard);
    reflector = module.get(Reflector);
  });

  it('allows the request when no @RequirePermission metadata is set', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    await expect(guard.canActivate(buildContext())).resolves.toBe(true);
  });

  it('denies with 401 when request.user is absent', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'docs', action: 'read' });

    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('denies with 403 when the user has no matching grant', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'docs', action: 'read' });
    accessConfigService.hasPermission.mockReturnValue(false);

    await expect(
      guard.canActivate(buildContext({ id: 'user-1', roles: ['editor'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows when the user has a matching grant', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'docs', action: 'read' });
    accessConfigService.hasPermission.mockReturnValue(true);

    await expect(
      guard.canActivate(buildContext({ id: 'user-1', roles: ['editor'] })),
    ).resolves.toBe(true);
  });

  it('allows when only one of the user two roles grants access (FR-022)', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'docs', action: 'read' });
    accessConfigService.hasPermission.mockImplementation((roles: string[]) =>
      roles.includes('editor'),
    );

    await expect(
      guard.canActivate(
        buildContext({ id: 'user-1', roles: ['viewer', 'editor'] }),
      ),
    ).resolves.toBe(true);
  });

  it('records a management_access_denied audit event when denying an rbac:manage check', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'rbac', action: 'manage' });
    accessConfigService.hasPermission.mockReturnValue(false);

    await expect(
      guard.canActivate(buildContext({ id: 'user-1', roles: ['viewer'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(rbacAuditService.record).toHaveBeenCalledWith(
      RbacAuditEventType.MANAGEMENT_ACCESS_DENIED,
      RbacAuditOutcome.FAILURE,
      expect.objectContaining({ actorUserId: 'user-1' }),
    );
  });

  it('does not record an audit event for ordinary (non-rbac) denied checks', async () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ permission: 'docs', action: 'read' });
    accessConfigService.hasPermission.mockReturnValue(false);

    await expect(
      guard.canActivate(buildContext({ id: 'user-1', roles: ['viewer'] })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(rbacAuditService.record).not.toHaveBeenCalled();
  });
});
