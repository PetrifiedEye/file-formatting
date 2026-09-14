import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import { UserRole } from './entities/user-role.entity';
import { RbacSelfLockoutService } from './rbac-self-lockout.service';

describe('RbacSelfLockoutService', () => {
  let service: RbacSelfLockoutService;

  const userRoleRepository = { find: jest.fn() };
  const grantRepository = { find: jest.fn() };
  const permissionRepository = { findOne: jest.fn() };

  const rbacPermission = { id: 'perm-rbac', name: 'rbac', actions: ['manage'] };

  beforeEach(async () => {
    jest.clearAllMocks();
    permissionRepository.findOne.mockResolvedValue(rbacPermission);
    userRoleRepository.find.mockResolvedValue([{ roleId: 'role-admin' }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RbacSelfLockoutService,
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepository },
        { provide: getRepositoryToken(Grant), useValue: grantRepository },
        {
          provide: getRepositoryToken(Permission),
          useValue: permissionRepository,
        },
      ],
    }).compile();

    service = module.get(RbacSelfLockoutService);
  });

  it('blocks deleting the only grant carrying the actor rbac:manage', async () => {
    grantRepository.find.mockResolvedValue([
      { id: 'grant-1', roleId: 'role-admin', actions: ['manage'] },
    ]);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'grant-deleted',
        grantId: 'grant-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows deleting one grant while another role still grants it', async () => {
    userRoleRepository.find.mockResolvedValue([
      { roleId: 'role-admin' },
      { roleId: 'role-ops' },
    ]);
    grantRepository.find.mockResolvedValue([
      { id: 'grant-1', roleId: 'role-admin', actions: ['manage'] },
      { id: 'grant-2', roleId: 'role-ops', actions: ['manage'] },
    ]);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'grant-deleted',
        grantId: 'grant-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks narrowing the actor own grant away from manage', async () => {
    grantRepository.find.mockResolvedValue([
      { id: 'grant-1', roleId: 'role-admin', actions: ['manage'] },
    ]);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'grant-actions',
        grantId: 'grant-1',
        actions: ['read'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows narrowing a grant that keeps manage', async () => {
    grantRepository.find.mockResolvedValue([
      { id: 'grant-1', roleId: 'role-admin', actions: ['manage'] },
    ]);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'grant-actions',
        grantId: 'grant-1',
        actions: ['manage'],
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks deleting the role that carries the actor only rbac grant', async () => {
    grantRepository.find.mockResolvedValue([]);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'role-deleted',
        roleId: 'role-admin',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The remaining role set is empty, so no grant lookup can rescue it.
    expect(grantRepository.find).not.toHaveBeenCalled();
  });

  it('skips the check for a system caller with no session', async () => {
    await expect(
      service.assertRetainsControl(null, {
        kind: 'grant-deleted',
        grantId: 'grant-1',
      }),
    ).resolves.toBeUndefined();
    expect(permissionRepository.findOne).not.toHaveBeenCalled();
  });

  it('does not block when the rbac permission itself no longer exists', async () => {
    permissionRepository.findOne.mockResolvedValue(null);

    await expect(
      service.assertRetainsControl('admin-1', {
        kind: 'grant-deleted',
        grantId: 'grant-1',
      }),
    ).resolves.toBeUndefined();
  });
});
