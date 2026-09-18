import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  UnauthorizedException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';

import { TransformationHistoryAuditOutcome } from './entities/transformation-history-audit-event.entity';
import { TransformationHistoryAuditService } from './transformation-history-audit.service';

interface RequestWithMaybeUser extends FastifyRequest {
  user?: RequestUser;
}

const HISTORY_PATH = '/api/transformations/history';

/**
 * Audits the outcomes the controller never sees.
 *
 * 401, 429 and 400 are all raised before (or instead of) the handler — by the
 * guard, the throttler and the validation pipe respectively — so the handler
 * cannot record them. FR-017 asks for a row on *every* outcome, which makes
 * this filter the only place three of the six can be written.
 *
 * The write is fire-and-forget: Nest does not await `catch`, and the response
 * must not wait on an audit row either way.
 */
@Catch(UnauthorizedException, ThrottlerException, BadRequestException)
export class TransformationHistoryAuditFilter extends BaseExceptionFilter {
  constructor(
    private readonly auditService: TransformationHistoryAuditService,
  ) {
    super();
  }

  catch(exception: Error, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<RequestWithMaybeUser>();

    if (this.isHistoryRequest(request)) {
      const outcome = this.resolveOutcome(exception);
      if (outcome) {
        void this.auditService
          .record({
            actorUserId: request.user?.id ?? null,
            targetUserId: this.targetUserIdOf(request),
            outcome,
          })
          .catch(() => undefined);
      }
    }

    // Always, whatever the audit write did: this filter observes the response,
    // it does not decide it.
    super.catch(exception, host);
  }

  private pathOf(request: RequestWithMaybeUser): string | null {
    if (request.method !== 'GET') {
      return null;
    }
    return request.url?.split('?')[0] ?? null;
  }

  private isHistoryRequest(request: RequestWithMaybeUser): boolean {
    const path = this.pathOf(request);
    if (!path) {
      return false;
    }

    // The collection route, or the admin route with exactly one more segment.
    // Matched on shape rather than on a router parameter, because a 401 is
    // raised before the route is ever resolved.
    return (
      path === HISTORY_PATH ||
      (path.startsWith(`${HISTORY_PATH}/`) &&
        !path.slice(HISTORY_PATH.length + 1).includes('/'))
    );
  }

  /**
   * The id as it was *requested*, not as it was resolved — on a 400 it may not
   * even be a UUID, and on a 401 nothing has looked it up. It is recorded only
   * to say which route was hit and at whom it was aimed.
   */
  private targetUserIdOf(request: RequestWithMaybeUser): string | null {
    const path = this.pathOf(request);
    if (!path || !path.startsWith(`${HISTORY_PATH}/`)) {
      return null;
    }

    const segment = path.slice(HISTORY_PATH.length + 1);
    return UUID_PATTERN.test(segment) ? segment : null;
  }

  private resolveOutcome(
    exception: Error,
  ): TransformationHistoryAuditOutcome | null {
    if (exception instanceof UnauthorizedException) {
      return TransformationHistoryAuditOutcome.UNAUTHENTICATED;
    }
    if (exception instanceof ThrottlerException) {
      return TransformationHistoryAuditOutcome.RATE_LIMITED;
    }
    if (exception instanceof BadRequestException) {
      return TransformationHistoryAuditOutcome.INVALID;
    }
    return null;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
