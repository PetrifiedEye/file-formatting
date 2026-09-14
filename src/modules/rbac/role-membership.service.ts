import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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

/**
 * Role membership is the one half of RBAC that had no API: roles, permissions
 * and grants were all manageable and audited, while `user_roles` — who
 * actually holds a role — could only be changed with direct SQL, outside the
 * audit trail entirely.
 */
@Injectable()
export class RoleMembershipService {
  constructor(
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly rbacAuditService: RbacAuditService,
    private readonly selfLockoutService: RbacSelfLockoutService,
  ) {}

  async list(roleId: string): Promise<UserRole[]> {
    await this.requireRole(roleId);

    return this.userRoleRepository.find({
      where: { roleId },
      order: { createdAt: 'ASC' },
    });
  }

  async assign(
    roleId: string,
    userId: string,
    actorUserId?: string | null,
  ): Promise<UserRole> {
    await this.requireRole(roleId);
    await this.requireUser(userId);

    const existing = await this.userRoleRepository.findOne({
      where: { roleId, userId },
    });

    // Idempotent: asking for a membership that already exists is not an error,
    // and re-recording it would put a misleading row in the audit trail.
    if (existing) {
      return existing;
    }

    const membership = await this.userRoleRepository.save(
      this.userRoleRepository.create({ roleId, userId }),
    );

    await this.record(
      RbacAuditEventType.ROLE_MEMBERSHIP_GRANTED,
      roleId,
      userId,
      actorUserId ?? null,
    );

    return membership;
  }

  async revoke(
    roleId: string,
    userId: string,
    actorUserId?: string | null,
  ): Promise<void> {
    await this.requireRole(roleId);

    const existing = await this.userRoleRepository.findOne({
      where: { roleId, userId },
    });

    if (!existing) {
      return;
    }

    // Revoking your own last role carrying `rbac:manage` locks everybody out
    // of RBAC management, exactly as deleting the role would.
    if (userId === actorUserId) {
      await this.selfLockoutService.assertRetainsControl(actorUserId, {
        kind: 'role-deleted',
        roleId,
      });
    }

    await this.userRoleRepository.delete({ roleId, userId });

    await this.record(
      RbacAuditEventType.ROLE_MEMBERSHIP_REVOKED,
      roleId,
      userId,
      actorUserId ?? null,
    );
  }

  private async record(
    eventType: RbacAuditEventType,
    roleId: string,
    userId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.rbacAuditService.record(eventType, RbacAuditOutcome.SUCCESS, {
      actorUserId,
      entityType: RbacAuditEntityType.MEMBERSHIP,
      entityId: roleId,
      metadata: { roleId, userId },
    });
  }

  private async requireRole(roleId: string): Promise<Role> {
    const role = await this.roleRepository.findOne({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException(`Role ${roleId} not found`);
    }
    return role;
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    return user;
  }
}
