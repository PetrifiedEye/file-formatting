import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { RbacAuditService } from './rbac-audit.service';

interface AccessSnapshot {
  permissionNames: Set<string>;
  grantsByRole: Map<string, Map<string, Set<string> | 'ALL'>>;
}

const EMPTY_SNAPSHOT: AccessSnapshot = {
  permissionNames: new Set(),
  grantsByRole: new Map(),
};

@Injectable()
export class AccessConfigService implements OnModuleInit {
  private snapshot: AccessSnapshot = EMPTY_SNAPSHOT;

  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,
    @InjectRepository(Grant)
    private readonly grantRepository: Repository<Grant>,
    private readonly rbacAuditService: RbacAuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.snapshot = await this.buildSnapshot();
  }

  hasPermission(
    roleNames: string[],
    permission: string,
    action: string,
  ): boolean {
    if (!this.snapshot.permissionNames.has(permission)) {
      return false;
    }

    for (const roleName of roleNames) {
      const roleGrants = this.snapshot.grantsByRole.get(roleName);
      if (!roleGrants) {
        continue;
      }

      const actions = roleGrants.get(permission);
      if (!actions) {
        continue;
      }

      if (actions === 'ALL' || actions.has(action)) {
        return true;
      }
    }

    return false;
  }

  async reload(): Promise<void> {
    let newSnapshot: AccessSnapshot;

    try {
      newSnapshot = await this.buildSnapshot();
    } catch (error) {
      await this.rbacAuditService.record(
        RbacAuditEventType.CONFIG_RELOAD_FAILED,
        RbacAuditOutcome.FAILURE,
        {
          entityType: RbacAuditEntityType.CONFIG,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
      );
      return;
    }

    this.snapshot = newSnapshot;

    await this.rbacAuditService.record(
      RbacAuditEventType.CONFIG_RELOADED,
      RbacAuditOutcome.SUCCESS,
      { entityType: RbacAuditEntityType.CONFIG },
    );
  }

  private async buildSnapshot(): Promise<AccessSnapshot> {
    const [roles, permissions, grants] = await Promise.all([
      this.roleRepository.find(),
      this.permissionRepository.find(),
      this.grantRepository.find(),
    ]);

    const roleById = new Map(roles.map((role) => [role.id, role]));
    const permissionById = new Map(
      permissions.map((permission) => [permission.id, permission]),
    );

    const permissionNames = new Set(
      permissions.map((permission) => permission.name),
    );
    const grantsByRole = new Map<string, Map<string, Set<string> | 'ALL'>>();

    for (const grant of grants) {
      const role = roleById.get(grant.roleId);
      const permission = permissionById.get(grant.permissionId);
      if (!role || !permission) {
        continue;
      }

      let roleGrants = grantsByRole.get(role.name);
      if (!roleGrants) {
        roleGrants = new Map();
        grantsByRole.set(role.name, roleGrants);
      }

      const permissionActionSet = new Set(permission.actions);
      const grantActions =
        !grant.actions || grant.actions.length === 0
          ? 'ALL'
          : new Set(
              grant.actions.filter((action) => permissionActionSet.has(action)),
            );

      roleGrants.set(permission.name, grantActions);
    }

    return { permissionNames, grantsByRole };
  }
}
