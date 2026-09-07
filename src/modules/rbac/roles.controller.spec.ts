import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { TokenService } from '@/modules/auth/token.service';
import { LoginAuditService } from '@/modules/auth/login-audit.service';
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
import { RolesService } from './roles.service';

describe('RolesController', () => {
  let controller: RolesController;

  const rolesService = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [
        { provide: RolesService, useValue: rolesService },
        JwtAuthGuard,
        { provide: TokenService, useValue: { verifyAccessToken: jest.fn() } },
        { provide: LoginAuditService, useValue: { record: jest.fn() } },
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

  it('delegates delete() to the service', async () => {
    await controller.delete('role-1', {});

    expect(rolesService.delete).toHaveBeenCalledWith('role-1', null);
  });
});
