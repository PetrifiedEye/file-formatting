import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FastifyRequest } from 'fastify';

import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { User, UserStatus } from '@/modules/users/entities/user.entity';

import {
  LoginAuditEventType,
  LoginAuditOutcome,
} from '../entities/login-audit-event.entity';
import { LoginAuditService } from '../login-audit.service';
import { TokenService, TokenVerificationError } from '../token.service';

export interface RequestUser {
  id: string;
  roles: string[];
}

interface RequestWithUser extends FastifyRequest {
  user?: RequestUser;
}

const AUTH_REQUIRED_MESSAGE = 'Authentication required';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly loginAuditService: LoginAuditService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const rawToken = request.cookies?.access_token;

    if (!rawToken) {
      return this.reject('missing');
    }

    let sub: string;
    try {
      ({ sub } = await this.tokenService.verifyAccessToken(rawToken));
    } catch (error) {
      const reason =
        error instanceof TokenVerificationError ? error.reason : 'malformed';
      return this.reject(reason);
    }

    const user = await this.userRepository.findOne({ where: { id: sub } });

    if (!user) {
      return this.reject('user_not_found');
    }

    if (user.status !== UserStatus.ACTIVE) {
      return this.reject('user_inactive');
    }

    const memberships = await this.userRoleRepository.find({
      where: { userId: user.id },
      relations: ['role'],
    });

    request.user = {
      id: user.id,
      roles: memberships.map((membership) => membership.role.name),
    };

    return true;
  }

  private async reject(failureReason: string): Promise<never> {
    await this.loginAuditService.record(
      LoginAuditEventType.ACCESS_CHECK_FAILED,
      LoginAuditOutcome.FAILURE,
      {
        normalizedEmail: 'unknown',
        failureReason,
      },
    );

    throw new UnauthorizedException(AUTH_REQUIRED_MESSAGE);
  }
}
