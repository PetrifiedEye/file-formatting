import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AccessConfigService } from './access-config.service';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { GrantsService } from './grants.service';
import { RbacAuditService } from './rbac-audit.service';

describe('GrantsService', () => {
  let service: GrantsService;

  beforeAll(() => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    addTransactionalDataSource({
      name: 'default',
      // @Transactional() methods only need `.transaction(cb)` here — no real DB.
      dataSource: {
        transaction: (cb: (m: unknown) => unknown) => cb({}),
      } as never,
      patch: false,
    });
  });

  const grantRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data: Partial<Grant>) => data),
    save: jest.fn((grant: Partial<Grant>) =>
      Promise.resolve({ id: 'grant-1', ...grant }),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const roleRepository = { findOne: jest.fn() };
  const permissionRepository = { findOne: jest.fn() };
  const accessConfigService = {
    reload: jest.fn().mockResolvedValue(undefined),
  };
  const rbacAuditService = { record: jest.fn().mockResolvedValue(undefined) };

  const role: Role = {
    id: 'role-1',
    name: 'editor',
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const permission: Permission = {
    id: 'perm-1',
    name: 'docs',
    description: null,
    actions: ['read', 'write'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrantsService,
        { provide: getRepositoryToken(Grant), useValue: grantRepository },
        { provide: getRepositoryToken(Role), useValue: roleRepository },
        {
          provide: getRepositoryToken(Permission),
          useValue: permissionRepository,
        },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: RbacAuditService, useValue: rbacAuditService },
      ],
    }).compile();

    service = module.get(GrantsService);
  });

  it('creates a grant with full actions when omitted', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(permission);
    grantRepository.findOne.mockResolvedValue(null);

    const grant = await service.create({
      roleId: role.id,
      permissionId: permission.id,
    });

    expect(grant.actions).toBeNull();
    expect(accessConfigService.reload).toHaveBeenCalled();
  });

  it('creates a grant with full actions when actions is an empty array', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(permission);
    grantRepository.findOne.mockResolvedValue(null);

    const grant = await service.create({
      roleId: role.id,
      permissionId: permission.id,
      actions: [],
    });

    expect(grant.actions).toBeNull();
  });

  it('creates a grant with a partial action subset', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(permission);
    grantRepository.findOne.mockResolvedValue(null);

    const grant = await service.create({
      roleId: role.id,
      permissionId: permission.id,
      actions: ['read'],
    });

    expect(grant.actions).toEqual(['read']);
  });

  it('rejects a duplicate role-permission pair', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(permission);
    grantRepository.findOne.mockResolvedValue({ id: 'grant-existing' });

    await expect(
      service.create({ roleId: role.id, permissionId: permission.id }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects actions outside the permission actions', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(permission);

    await expect(
      service.create({
        roleId: role.id,
        permissionId: permission.id,
        actions: ['delete'],
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('throws 404 when the role is not found', async () => {
    roleRepository.findOne.mockResolvedValue(null);

    await expect(
      service.create({ roleId: 'missing', permissionId: permission.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the permission is not found', async () => {
    roleRepository.findOne.mockResolvedValue(role);
    permissionRepository.findOne.mockResolvedValue(null);

    await expect(
      service.create({ roleId: role.id, permissionId: 'missing' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates a grant action scope', async () => {
    grantRepository.findOne.mockResolvedValue({
      id: 'grant-1',
      roleId: role.id,
      permissionId: permission.id,
      actions: null,
    });
    permissionRepository.findOne.mockResolvedValue(permission);

    const grant = await service.update('grant-1', { actions: ['write'] });

    expect(grant.actions).toEqual(['write']);
  });

  it('deletes a grant', async () => {
    grantRepository.findOne.mockResolvedValue({ id: 'grant-1' });

    await service.delete('grant-1');

    expect(grantRepository.delete).toHaveBeenCalledWith('grant-1');
  });

  it('throws 404 deleting a missing grant', async () => {
    grantRepository.findOne.mockResolvedValue(null);

    await expect(service.delete('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
