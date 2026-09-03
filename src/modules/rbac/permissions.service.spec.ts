import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessConfigService } from './access-config.service';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import { PermissionsService } from './permissions.service';
import { RbacAuditService } from './rbac-audit.service';

describe('PermissionsService', () => {
  let service: PermissionsService;

  const permissionRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data: Partial<Permission>) => data),
    save: jest.fn((permission: Partial<Permission>) =>
      Promise.resolve({ id: 'perm-1', ...permission }),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const grantRepository = { findOne: jest.fn() };
  const accessConfigService = {
    reload: jest.fn().mockResolvedValue(undefined),
  };
  const rbacAuditService = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionsService,
        {
          provide: getRepositoryToken(Permission),
          useValue: permissionRepository,
        },
        { provide: getRepositoryToken(Grant), useValue: grantRepository },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: RbacAuditService, useValue: rbacAuditService },
      ],
    }).compile();

    service = module.get(PermissionsService);
  });

  it('lists all permissions', async () => {
    permissionRepository.find.mockResolvedValue([{ id: 'perm-1' }]);

    expect(await service.list()).toHaveLength(1);
  });

  it('creates a permission and triggers reload + audit', async () => {
    permissionRepository.findOne.mockResolvedValue(null);

    const permission = await service.create(
      { name: 'docs', actions: ['read'] },
      'actor-1',
    );

    expect(permission.name).toBe('docs');
    expect(accessConfigService.reload).toHaveBeenCalled();
    expect(rbacAuditService.record).toHaveBeenCalled();
  });

  it('rejects creating a permission with empty actions', async () => {
    await expect(
      service.create({ name: 'docs', actions: [] }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a duplicate permission name', async () => {
    permissionRepository.findOne.mockResolvedValue({ id: 'perm-1' });

    await expect(
      service.create({ name: 'docs', actions: ['read'] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates a permission actions list', async () => {
    permissionRepository.findOne.mockResolvedValue({
      id: 'perm-1',
      name: 'docs',
      description: null,
      actions: ['read'],
    });

    const permission = await service.update('perm-1', {
      actions: ['read', 'write'],
    });

    expect(permission.actions).toEqual(['read', 'write']);
  });

  it('rejects updating a permission to empty actions', async () => {
    permissionRepository.findOne.mockResolvedValue({
      id: 'perm-1',
      name: 'docs',
      actions: ['read'],
    });

    await expect(
      service.update('perm-1', { actions: [] }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('throws 404 updating a missing permission', async () => {
    permissionRepository.findOne.mockResolvedValue(null);

    await expect(
      service.update('missing', { actions: ['read'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a permission with no dependent grants', async () => {
    permissionRepository.findOne.mockResolvedValue({ id: 'perm-1' });
    grantRepository.findOne.mockResolvedValue(null);

    await service.delete('perm-1');

    expect(permissionRepository.delete).toHaveBeenCalledWith('perm-1');
  });

  it('blocks deleting a permission referenced by a grant', async () => {
    permissionRepository.findOne.mockResolvedValue({ id: 'perm-1' });
    grantRepository.findOne.mockResolvedValue({ id: 'grant-1' });

    await expect(service.delete('perm-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
