import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AccessConfigService } from '../access-config.service';
import {
  REQUIRE_PERMISSION_KEY,
  RequiredPermission,
} from '../decorators/require-permission.decorator';
import {
  RbacAuditEntityType,
  RbacAuditEventType,
  RbacAuditOutcome,
} from '../entities/rbac-audit-event.entity';
import { RbacAuditService } from '../rbac-audit.service';

export interface RequestUser {
  id: string;
  roles: string[];
}

interface RequestWithUser {
  user?: RequestUser;
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessConfigService: AccessConfigService,
    private readonly rbacAuditService: RbacAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      RequiredPermission | undefined
    >(REQUIRE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const allowed = this.accessConfigService.hasPermission(
      user.roles,
      required.permission,
      required.action,
    );

    if (!allowed) {
      if (required.permission === 'rbac') {
        await this.rbacAuditService.record(
          RbacAuditEventType.MANAGEMENT_ACCESS_DENIED,
          RbacAuditOutcome.FAILURE,
          {
            actorUserId: user.id,
            entityType: RbacAuditEntityType.CONFIG,
            reason: `missing ${required.permission}:${required.action}`,
          },
        );
      }

      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
