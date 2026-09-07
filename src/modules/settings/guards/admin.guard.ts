import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';

const ADMIN_ROLE = 'admin';

interface RequestWithUser {
  user?: { id: string; roles: string[] };
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(forwardRef(() => JwtAuthGuard))
    private readonly jwtAuthGuard: JwtAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.jwtAuthGuard.canActivate(context);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const roles = request.user?.roles ?? [];

    if (!roles.includes(ADMIN_ROLE)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
