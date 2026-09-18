import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  UnauthorizedException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';

import { TransformationResultAuditService } from './transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';

interface RequestWithMaybeUser extends FastifyRequest {
  user?: RequestUser;
}

interface RouteIds {
  itemId: string | null;
  targetUserId: string | null;
}

@Catch(UnauthorizedException, ThrottlerException, BadRequestException)
export class TransformationResultAuditFilter extends BaseExceptionFilter {
  constructor(private readonly auditService: TransformationResultAuditService) {
    super();
  }

  catch(exception: Error, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<RequestWithMaybeUser>();
    const routeIds = this.routeIds(request);
    const outcome = this.outcomeOf(exception);

    if (routeIds && outcome) {
      void this.auditService.record({
        actorUserId: request.user?.id ?? null,
        targetUserId: routeIds.targetUserId,
        conversionRecordId: routeIds.itemId,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome,
        durationMs: 0,
      });
    }

    super.catch(exception, host);
  }

  private routeIds(request: RequestWithMaybeUser): RouteIds | null {
    if (request.method !== 'GET') {
      return null;
    }

    const path = request.url?.split('?')[0] ?? '';
    const self = path.match(
      /^\/api\/transformations\/history\/([^/]+)\/download$/,
    );
    if (self) {
      return {
        itemId: uuidOrNull(self[1]),
        targetUserId: null,
      };
    }

    const admin = path.match(
      /^\/admin\/users\/([^/]+)\/transformations\/history\/([^/]+)\/download$/,
    );
    if (admin) {
      return {
        targetUserId: uuidOrNull(admin[1]),
        itemId: uuidOrNull(admin[2]),
      };
    }

    return null;
  }

  private outcomeOf(exception: Error): TransformationResultAuditOutcome | null {
    if (exception instanceof UnauthorizedException) {
      return TransformationResultAuditOutcome.UNAUTHENTICATED;
    }
    if (exception instanceof ThrottlerException) {
      return TransformationResultAuditOutcome.RATE_LIMITED;
    }
    if (exception instanceof BadRequestException) {
      return TransformationResultAuditOutcome.INVALID;
    }
    return null;
  }
}

function uuidOrNull(value: string): string | null {
  return UUID_PATTERN.test(value) ? value : null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
