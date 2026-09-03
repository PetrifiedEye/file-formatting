import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccessConfigService } from './access-config.service';
import { Grant } from './entities/grant.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';
import { RolesService } from './roles.service';

describe('RolesService', () => {
  let service: RolesService;

  const roleRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data: Partial<Role>) => data),
    save: jest.fn((role: Partial<Role>) =>
      Promise.resolve({ id: 'role-1', ...role }),
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
        RolesService,
        { provide: getRepositoryToken(Role), useValue: roleRepository },
        { provide: getRepositoryToken(Grant), useValue: grantRepository },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: RbacAuditService, useValue: rbacAuditService },
      ],
    }).compile();

    service = module.get(RolesService);
  });

  it('lists all roles', async () => {
    roleRepository.find.mockResolvedValue([{ id: 'role-1', name: 'editor' }]);

    const result = await service.list();

    expect(result).toHaveLength(1);
  });

  it('creates a role and triggers reload + audit', async () => {
    roleRepository.findOne.mockResolvedValue(null);

    const role = await service.create({ name: 'editor' }, 'actor-1');

    expect(role.name).toBe('editor');
    expect(accessConfigService.reload).toHaveBeenCalled();
    expect(rbacAuditService.record).toHaveBeenCalled();
  });

  it('rejects a duplicate role name on create', async () => {
    roleRepository.findOne.mockResolvedValue({ id: 'role-1', name: 'editor' });

    await expect(service.create({ name: 'editor' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('updates a role', async () => {
    roleRepository.findOne
      .mockResolvedValueOnce({
        id: 'role-1',
        name: 'editor',
        description: null,
      })
      .mockResolvedValueOnce(null);

    const role = await service.update('role-1', { name: 'editor-2' });

    expect(role.name).toBe('editor-2');
    expect(accessConfigService.reload).toHaveBeenCalled();
  });

  it('rejects updating to a name already used by another role', async () => {
    roleRepository.findOne
      .mockResolvedValueOnce({
        id: 'role-1',
        name: 'editor',
        description: null,
      })
      .mockResolvedValueOnce({ id: 'role-2', name: 'viewer' });

    await expect(
      service.update('role-1', { name: 'viewer' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 404 updating a missing role', async () => {
    roleRepository.findOne.mockResolvedValue(null);

    await expect(
      service.update('missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a role with no dependent grants', async () => {
    roleRepository.findOne.mockResolvedValue({ id: 'role-1', name: 'editor' });
    grantRepository.findOne.mockResolvedValue(null);

    await service.delete('role-1');

    expect(roleRepository.delete).toHaveBeenCalledWith('role-1');
    expect(accessConfigService.reload).toHaveBeenCalled();
  });

  it('blocks deleting a role referenced by a grant', async () => {
    roleRepository.findOne.mockResolvedValue({ id: 'role-1', name: 'editor' });
    grantRepository.findOne.mockResolvedValue({ id: 'grant-1' });

    await expect(service.delete('role-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws 404 deleting a missing role', async () => {
    roleRepository.findOne.mockResolvedValue(null);

    await expect(service.delete('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
