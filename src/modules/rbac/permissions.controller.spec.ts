import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SessionAuthGuard } from '@/modules/auth/guards/session-auth.guard';
import { SessionService } from '@/modules/auth/session.service';
import { UserRole } from './entities/user-role.entity';

import { AccessConfigService } from './access-config.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from './decorators/require-permission.decorator';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RbacAuditService } from './rbac-audit.service';

describe('PermissionsController', () => {
  let controller: PermissionsController;

  const permissionsService = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PermissionsController],
      providers: [
        { provide: PermissionsService, useValue: permissionsService },
        SessionAuthGuard,
        { provide: SessionService, useValue: { validate: jest.fn() } },
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

    controller = module.get(PermissionsController);
  });

  it('is guarded by PermissionGuard requiring rbac:manage', () => {
    const reflector = new Reflector();
    const required = reflector.get<RequiredPermission>(
      REQUIRE_PERMISSION_KEY,
      PermissionsController,
    );

    expect(required).toEqual({ permission: 'rbac', action: 'manage' });
  });

  it('delegates list() to the service', async () => {
    permissionsService.list.mockResolvedValue([{ id: 'perm-1' }]);

    expect(await controller.list()).toEqual([{ id: 'perm-1' }]);
  });

  it('delegates create() to the service with the actor id', async () => {
    permissionsService.create.mockResolvedValue({ id: 'perm-1' });

    await controller.create(
      { name: 'docs', actions: ['read'] },
      { user: { id: 'actor-1', roles: [] } },
    );

    expect(permissionsService.create).toHaveBeenCalledWith(
      { name: 'docs', actions: ['read'] },
      'actor-1',
    );
  });

  it('delegates update() to the service', async () => {
    permissionsService.update.mockResolvedValue({ id: 'perm-1' });

    await controller.update('perm-1', { actions: ['read'] }, {});

    expect(permissionsService.update).toHaveBeenCalledWith(
      'perm-1',
      { actions: ['read'] },
      null,
    );
  });

  it('delegates delete() to the service', async () => {
    await controller.delete('perm-1', {});

    expect(permissionsService.delete).toHaveBeenCalledWith('perm-1', null);
  });
});
