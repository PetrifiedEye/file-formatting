import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';

import { UserDirectoryAuditOutcome } from './entities/user-directory-audit-event.entity';
import { UserDirectoryAuditService } from './user-directory-audit.service';

interface RequestWithMaybeUser extends FastifyRequest {
  user?: RequestUser;
}

const DIRECTORY_COLLECTION_PATH = '/users';

@Catch(UnauthorizedException, ThrottlerException, BadRequestException)
export class UserDirectoryAuditFilter extends BaseExceptionFilter {
  constructor(
    private readonly userDirectoryAuditService: UserDirectoryAuditService,
  ) {
    super();
  }

  catch(exception: Error, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<RequestWithMaybeUser>();

    if (this.isDirectoryCollectionRequest(request)) {
      const outcome = this.resolveOutcome(exception);
      if (outcome) {
        void this.userDirectoryAuditService
          .record({ actorId: request.user?.id ?? null, outcome })
          .catch(() => undefined);
      }
    }

    super.catch(exception, host);
  }

  private isDirectoryCollectionRequest(request: RequestWithMaybeUser): boolean {
    if (request.method !== 'GET') {
      return false;
    }

    const path = request.url?.split('?')[0];
    return path === DIRECTORY_COLLECTION_PATH;
  }

  private resolveOutcome(exception: Error): UserDirectoryAuditOutcome | null {
    if (exception instanceof UnauthorizedException) {
      return UserDirectoryAuditOutcome.UNAUTHENTICATED;
    }
    if (exception instanceof ThrottlerException) {
      return UserDirectoryAuditOutcome.RATE_LIMITED;
    }
    if (exception instanceof BadRequestException) {
      return UserDirectoryAuditOutcome.INVALID;
    }
    return null;
  }
}
