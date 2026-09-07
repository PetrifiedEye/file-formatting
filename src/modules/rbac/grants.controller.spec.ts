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
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { PermissionGuard } from './guards/permission.guard';
import { RbacAuditService } from './rbac-audit.service';

describe('GrantsController', () => {
  let controller: GrantsController;

  const grantsService = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GrantsController],
      providers: [
        { provide: GrantsService, useValue: grantsService },
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

    controller = module.get(GrantsController);
  });

  it('is guarded by PermissionGuard requiring rbac:manage', () => {
    const reflector = new Reflector();
    const required = reflector.get<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      GrantsController,
    );

    expect(required).toEqual({ permission: 'rbac', action: 'manage' });
  });

  it('delegates list() to the service with query filters', async () => {
    grantsService.list.mockResolvedValue([{ id: 'grant-1' }]);

    await controller.list('role-1', 'perm-1');

    expect(grantsService.list).toHaveBeenCalledWith('role-1', 'perm-1');
  });

  it('delegates create() to the service with the actor id', async () => {
    grantsService.create.mockResolvedValue({ id: 'grant-1' });

    await controller.create(
      { roleId: 'role-1', permissionId: 'perm-1' },
      { user: { id: 'actor-1', roles: [] } },
    );

    expect(grantsService.create).toHaveBeenCalledWith(
      { roleId: 'role-1', permissionId: 'perm-1' },
      'actor-1',
    );
  });

  it('delegates update() to the service', async () => {
    grantsService.update.mockResolvedValue({ id: 'grant-1' });

    await controller.update('grant-1', { actions: ['read'] }, {});

    expect(grantsService.update).toHaveBeenCalledWith(
      'grant-1',
      { actions: ['read'] },
      null,
    );
  });

  it('delegates delete() to the service', async () => {
    await controller.delete('grant-1', {});

    expect(grantsService.delete).toHaveBeenCalledWith('grant-1', null);
  });
});
