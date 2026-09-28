import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { User } from '@/modules/users/entities/user.entity';

import { AccessConfigService } from './access-config.service';
import { Grant } from './entities/grant.entity';
import { Permission } from './entities/permission.entity';
import { RbacAuditEvent } from './entities/rbac-audit-event.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { GrantsController } from '@/modules/rbac/grants/grants.controller';
import { GrantsService } from '@/modules/rbac/grants/grants.service';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionsController } from '@/modules/rbac/permissions/permissions.controller';
import { PermissionsService } from '@/modules/rbac/permissions/permissions.service';
import { RbacAuditService } from '@/modules/rbac/audit/rbac-audit.service';
import { RbacSelfLockoutService } from './rbac-self-lockout.service';
import { RoleMembershipService } from '@/modules/rbac/roles/role-membership.service';
import { RolesController } from '@/modules/rbac/roles/roles.controller';
import { RolesService } from '@/modules/rbac/roles/roles.service';

const RbacEntitiesModule = TypeOrmModule.forFeature([
  Role,
  Permission,
  Grant,
  UserRole,
  RbacAuditEvent,
  // Read-only: membership assignment checks that the target user exists.
  User,
]);

@Module({
  imports: [RbacEntitiesModule, forwardRef(() => AuthModule)],
  controllers: [RolesController, PermissionsController, GrantsController],
  providers: [
    RbacAuditService,
    AccessConfigService,
    RbacSelfLockoutService,
    PermissionGuard,
    RolesService,
    RoleMembershipService,
    PermissionsService,
    GrantsService,
  ],
  exports: [
    RbacEntitiesModule,
    AccessConfigService,
    RbacAuditService,
    PermissionGuard,
  ],
})
export class RbacModule {}
