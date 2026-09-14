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
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { PermissionGuard } from './guards/permission.guard';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RbacAuditService } from './rbac-audit.service';
import { RbacSelfLockoutService } from './rbac-self-lockout.service';
import { RoleMembershipService } from './role-membership.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

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
