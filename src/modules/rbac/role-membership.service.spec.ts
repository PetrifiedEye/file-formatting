import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '@/modules/users/entities/user.entity';

import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { RbacAuditService } from './rbac-audit.service';
import { RbacSelfLockoutService } from './rbac-self-lockout.service';
import { RoleMembershipService } from './role-membership.service';

describe('RoleMembershipService', () => {
  let service: RoleMembershipService;

  const userRoleRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((data: Partial<UserRole>) => data),
    save: jest.fn((membership: Partial<UserRole>) =>
      Promise.resolve({ createdAt: new Date(), ...membership }),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const roleRepository = { findOne: jest.fn() };
  const userRepository = { findOne: jest.fn() };
  const rbacAuditService = { record: jest.fn().mockResolvedValue(undefined) };
  const selfLockoutService = {
    assertRetainsControl: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    roleRepository.findOne.mockResolvedValue({ id: 'role-1', name: 'editor' });
    userRepository.findOne.mockResolvedValue({ id: 'user-1' });
    userRoleRepository.findOne.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoleMembershipService,
        { provide: getRepositoryToken(UserRole), useValue: userRoleRepository },
        { provide: getRepositoryToken(Role), useValue: roleRepository },
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: RbacAuditService, useValue: rbacAuditService },
        { provide: RbacSelfLockoutService, useValue: selfLockoutService },
      ],
    }).compile();

    service = module.get(RoleMembershipService);
  });

  it('assigns a role and audits it', async () => {
    await service.assign('role-1', 'user-1', 'admin-1');

    expect(userRoleRepository.save).toHaveBeenCalled();
    expect(rbacAuditService.record).toHaveBeenCalledWith(
      RbacAuditEventType.ROLE_MEMBERSHIP_GRANTED,
      RbacAuditOutcome.SUCCESS,
      expect.objectContaining({
        actorUserId: 'admin-1',
        entityType: RbacAuditEntityType.MEMBERSHIP,
        metadata: { roleId: 'role-1', userId: 'user-1' },
      }),
    );
  });

  it('is idempotent and writes no audit row for an existing membership', async () => {
    userRoleRepository.findOne.mockResolvedValue({
      roleId: 'role-1',
      userId: 'user-1',
    });

    await service.assign('role-1', 'user-1', 'admin-1');

    expect(userRoleRepository.save).not.toHaveBeenCalled();
    expect(rbacAuditService.record).not.toHaveBeenCalled();
  });

  it('throws 404 for an unknown role', async () => {
    roleRepository.findOne.mockResolvedValue(null);

    await expect(service.assign('role-x', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 404 for an unknown user', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(service.assign('role-1', 'user-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revokes a membership and audits it', async () => {
    userRoleRepository.findOne.mockResolvedValue({
      roleId: 'role-1',
      userId: 'user-1',
    });

    await service.revoke('role-1', 'user-1', 'admin-1');

    expect(userRoleRepository.delete).toHaveBeenCalledWith({
      roleId: 'role-1',
      userId: 'user-1',
    });
    expect(rbacAuditService.record).toHaveBeenCalledWith(
      RbacAuditEventType.ROLE_MEMBERSHIP_REVOKED,
      RbacAuditOutcome.SUCCESS,
      expect.objectContaining({ entityId: 'role-1' }),
    );
  });

  it('refuses a self-revocation that would strip the actor own rbac access', async () => {
    userRoleRepository.findOne.mockResolvedValue({
      roleId: 'role-1',
      userId: 'admin-1',
    });
    selfLockoutService.assertRetainsControl.mockRejectedValueOnce(
      new ConflictException('locked out'),
    );

    await expect(
      service.revoke('role-1', 'admin-1', 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(userRoleRepository.delete).not.toHaveBeenCalled();
  });

  it('revoking a membership that is not there is a no-op', async () => {
    await service.revoke('role-1', 'user-1', 'admin-1');

    expect(userRoleRepository.delete).not.toHaveBeenCalled();
    expect(rbacAuditService.record).not.toHaveBeenCalled();
  });
});
