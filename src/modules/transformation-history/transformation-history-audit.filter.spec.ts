import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';

import { TransformationHistoryAuditOutcome } from './entities/transformation-history-audit-event.entity';
import { TransformationHistoryAuditFilter } from './transformation-history-audit.filter';
import { TransformationHistoryAuditService } from './transformation-history-audit.service';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const TARGET = '00000000-0000-4000-8000-0000000000bb';

interface RequestShape {
  method?: string;
  url?: string;
  user?: { id: string; roles: string[] };
}

function hostFor(request: RequestShape): ArgumentsHost {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ArgumentsHost;
}

describe('TransformationHistoryAuditFilter', () => {
  let auditService: { record: jest.Mock };
  let filter: TransformationHistoryAuditFilter;
  let superCatch: jest.SpyInstance;

  beforeEach(() => {
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    filter = new TransformationHistoryAuditFilter(
      auditService as unknown as TransformationHistoryAuditService,
    );

    superCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('outcome mapping', () => {
    it.each([
      [
        'an unauthenticated request',
        new UnauthorizedException(),
        TransformationHistoryAuditOutcome.UNAUTHENTICATED,
      ],
      [
        'a rate-limited request',
        new ThrottlerException(),
        TransformationHistoryAuditOutcome.RATE_LIMITED,
      ],
      [
        'an invalid request',
        new BadRequestException(),
        TransformationHistoryAuditOutcome.INVALID,
      ],
    ])('records %s', (_name, exception, outcome) => {
      filter.catch(
        exception,
        hostFor({
          method: 'GET',
          url: '/api/transformations/history?limit=5',
          user: { id: ACTOR, roles: [] },
        }),
      );

      expect(auditService.record).toHaveBeenCalledWith({
        actorUserId: ACTOR,
        targetUserId: null,
        outcome,
      });
    });

    it('records no actor when nobody was authenticated', () => {
      filter.catch(
        new UnauthorizedException(),
        hostFor({ method: 'GET', url: '/api/transformations/history' }),
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: null }),
      );
    });

    it('carries the requested target id on the admin route', () => {
      filter.catch(
        new UnauthorizedException(),
        hostFor({
          method: 'GET',
          url: `/api/transformations/history/${TARGET}?limit=5`,
        }),
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: TARGET }),
      );
    });

    it('records no target when the requested id is not a UUID', () => {
      // The 400 case: there is no account to name, only a bad request.
      filter.catch(
        new BadRequestException(),
        hostFor({
          method: 'GET',
          url: '/api/transformations/history/not-a-uuid',
        }),
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ targetUserId: null }),
      );
    });
  });

  describe('scope', () => {
    it.each([
      ['an unrelated path', 'GET', '/users'],
      [
        'a deeper path under the same prefix',
        'GET',
        '/api/transformations/history/a/b',
      ],
      ['a sibling route', 'GET', '/api/convert'],
      ['a non-GET method', 'POST', '/api/transformations/history'],
    ])('ignores %s', (_name, method, url) => {
      filter.catch(new BadRequestException(), hostFor({ method, url }));

      expect(auditService.record).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalled();
    });
  });

  describe('delegation', () => {
    it('always hands the exception on, whatever the audit write does', () => {
      auditService.record.mockRejectedValue(new Error('database is down'));
      const exception = new UnauthorizedException();
      const host = hostFor({
        method: 'GET',
        url: '/api/transformations/history',
      });

      expect(() => filter.catch(exception, host)).not.toThrow();
      expect(superCatch).toHaveBeenCalledWith(exception, host);
    });

    it('hands on an exception it does not audit', () => {
      // Not in @Catch, but the delegation contract holds regardless.
      const exception = new ForbiddenException();
      const host = hostFor({
        method: 'GET',
        url: '/api/transformations/history',
      });

      filter.catch(exception, host);

      expect(auditService.record).not.toHaveBeenCalled();
      expect(superCatch).toHaveBeenCalledWith(exception, host);
    });
  });
});
