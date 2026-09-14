import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { UserRole } from './entities/user-role.entity';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';

export const RBAC_PERMISSION = 'rbac';
export const RBAC_MANAGE_ACTION = 'manage';

const LOCKOUT_MESSAGE =
  'This change would remove your own rbac:manage access, leaving nobody able ' +
  'to administer roles, permissions, or grants. Grant the permission to ' +
  'another role you hold first.';

/**
 * A pending mutation, expressed as what it takes away from the caller.
 */
export type RbacControlChange =
  | { kind: 'grant-deleted'; grantId: string }
  | { kind: 'grant-actions'; grantId: string; actions: string[] }
  | { kind: 'role-deleted'; roleId: string };

/**
 * Guards the one permission nobody can afford to lose: an administrator who
 * deletes the grant (or the role) carrying their own `rbac:manage` locks
 * everyone out of RBAC management, and the only way back is direct SQL.
 */
@Injectable()
export class RbacSelfLockoutService {
  constructor(
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
  ) {}

  async assertRetainsControl(
    actorUserId: string | null | undefined,
    change: RbacControlChange,
  ): Promise<void> {
    // No actor means a system/bootstrap caller (migrations, seeds); there is no
    // session to lock out.
    if (!actorUserId) {
      return;
    }

    if (await this.retainsControl(actorUserId, change)) {
      return;
    }

    throw new ConflictException(LOCKOUT_MESSAGE);
  }

  private async retainsControl(
    actorUserId: string,
    change: RbacControlChange,
  ): Promise<boolean> {
    const permission = await this.permissionRepository.findOne({
      where: { name: RBAC_PERMISSION },
    });

    // Without the permission itself there is nothing left to protect.
    if (!permission) {
      return true;
    }

    const memberships = await this.userRoleRepository.find({
      where: { userId: actorUserId },
    });

    const roleIds = memberships
      .map((membership) => membership.roleId)
      .filter(
        (roleId) => change.kind !== 'role-deleted' || roleId !== change.roleId,
      );

    if (roleIds.length === 0) {
      return false;
    }

    const grants = await this.grantRepository.find({
      where: { permissionId: permission.id, roleId: In(roleIds) },
    });

    return grants.some((grant) => {
      if (change.kind === 'grant-deleted' && grant.id === change.grantId) {
        return false;
      }

      const actions =
        change.kind === 'grant-actions' && grant.id === change.grantId
          ? change.actions
          : grant.actions;

      // A grant confers exactly the actions it names; an unset list confers
      // nothing, so it cannot be what is keeping the actor in control.
      return actions?.includes(RBAC_MANAGE_ACTION) ?? false;
    });
  }
}
