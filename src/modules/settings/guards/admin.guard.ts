import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';

export const SETTINGS_PERMISSION = 'settings';
export const SETTINGS_MANAGE_ACTION = 'manage';

interface RequestWithUser {
  user?: { id: string; roles: string[] };
}

/**
 * Authorizes `/admin/settings` through the grant model.
 *
 * This used to test `roles.includes('admin')`, which bypassed RBAC entirely:
 * revoking the admin role's grants left the endpoint open, and renaming the
 * role locked every administrator out of it.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => JwtAuthGuard))
    private readonly jwtAuthGuard: JwtAuthGuard,
    @Inject(forwardRef(() => AccessConfigService))
    private readonly accessConfigService: AccessConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtAuthGuard.canActivate(context);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const roles = request.user?.roles ?? [];

    if (
      !this.accessConfigService.hasPermission(
        roles,
        SETTINGS_PERMISSION,
        SETTINGS_MANAGE_ACTION,
      )
    ) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
