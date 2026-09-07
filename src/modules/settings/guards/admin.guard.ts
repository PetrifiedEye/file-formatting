import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';

import { SessionAuthGuard } from '@/modules/auth/guards/session-auth.guard';

const ADMIN_ROLE = 'admin';

interface RequestWithUser {
  user?: { id: string; roles: string[] };
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => SessionAuthGuard))
    private readonly sessionAuthGuard: SessionAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessionAuthGuard.canActivate(context);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const roles = request.user?.roles ?? [];

    if (!roles.includes(ADMIN_ROLE)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
