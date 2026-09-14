import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { TokenService } from '@/modules/auth/token.service';
import { LoginAuditService } from '@/modules/auth/login-audit.service';
import { AuthSessionService } from '@/modules/auth/auth-session.service';
import { User } from '@/modules/users/entities/user.entity';
import { UserRole } from './entities/user-role.entity';

import { AccessConfigService } from './access-config.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from './decorators/require-permission.decorator';
import { PermissionGuard } from './guards/permission.guard';
import { RbacAuditService } from './rbac-audit.service';
import { RolesController } from './roles.controller';
import { RoleMembershipService } from './role-membership.service';
import { RolesService } from './roles.service';

describe('RolesController', () => {
  let controller: RolesController;

  const rolesService = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const membershipService = {
    list: jest.fn(),
    assign: jest.fn(),
    revoke: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [
        { provide: RolesService, useValue: rolesService },
        { provide: RoleMembershipService, useValue: membershipService },
        JwtAuthGuard,
        { provide: TokenService, useValue: { verifyAccessToken: jest.fn() } },
        { provide: LoginAuditService, useValue: { record: jest.fn() } },
        {
          provide: AuthSessionService,
          useValue: { findActive: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserRole),
          useValue: { find: jest.fn() },
        },
        PermissionGuard,
        Reflector,
        { provide: AccessConfigService, useValue: {} },
        { provide: RbacAuditService, useValue: {} },
      ],
    }).compile();

    controller = module.get(RolesController);
  });

  it('is guarded by PermissionGuard requiring rbac:manage', () => {
    const reflector = new Reflector();
    const required = reflector.get<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      RolesController,
    );

    expect(required).toEqual({ permission: 'rbac', action: 'manage' });

    // Metadata alone is inert: without the guards actually attached, every
    // endpoint below would be public and this suite would still pass.
    const guards = Reflect.getMetadata(
      '__guards__',
      RolesController,
    ) as unknown[];
    expect(guards).toEqual(
      expect.arrayContaining([JwtAuthGuard, PermissionGuard]),
    );
  });

  it('delegates list() to the service', async () => {
    rolesService.list.mockResolvedValue([{ id: 'role-1' }]);

    const result = await controller.list();

    expect(result).toEqual([{ id: 'role-1' }]);
    expect(rolesService.list).toHaveBeenCalled();
  });

  it('delegates create() to the service with the actor id', async () => {
    rolesService.create.mockResolvedValue({ id: 'role-1' });

    await controller.create(
      { name: 'editor' },
      { user: { id: 'actor-1', roles: [] } },
    );

    expect(rolesService.create).toHaveBeenCalledWith(
      { name: 'editor' },
      'actor-1',
    );
  });

  it('delegates update() to the service', async () => {
    rolesService.update.mockResolvedValue({ id: 'role-1' });

    await controller.update('role-1', { name: 'editor-2' }, {});

    expect(rolesService.update).toHaveBeenCalledWith(
      'role-1',
      { name: 'editor-2' },
      null,
    );
  });

  it('delegates the membership routes to the membership service', async () => {
    const actor = { id: 'actor-1', roles: [] };
    const roleId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';

    await controller.listMembers(roleId);
    expect(membershipService.list).toHaveBeenCalledWith(roleId);

    await controller.assignMember(roleId, userId, { user: actor });
    expect(membershipService.assign).toHaveBeenCalledWith(
      roleId,
      userId,
      actor.id,
    );

    await controller.revokeMember(roleId, userId, { user: actor });
    expect(membershipService.revoke).toHaveBeenCalledWith(
      roleId,
      userId,
      actor.id,
    );
  });

  it('delegates delete() to the service', async () => {
    await controller.delete('role-1', {});

    expect(rolesService.delete).toHaveBeenCalledWith('role-1', null);
  });
});
