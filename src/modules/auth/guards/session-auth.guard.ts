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

import { SessionService } from '../session.service';

export interface RequestUser {
  id: string;
  roles: string[];
}

interface RequestWithUser extends FastifyRequest {
  user?: RequestUser;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessionService: SessionService,
    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const rawToken = request.cookies?.session;

    if (!rawToken) {
      throw new UnauthorizedException('Authentication required');
    }

    const session = await this.sessionService.validate(rawToken);

    if (!session) {
      throw new UnauthorizedException('Authentication required');
    }

    const memberships = await this.userRoleRepository.find({
      where: { userId: session.userId },
      relations: ['role'],
    });

    request.user = {
      id: session.userId,
      roles: memberships.map((membership) => membership.role.name),
    };

    return true;
  }
}
