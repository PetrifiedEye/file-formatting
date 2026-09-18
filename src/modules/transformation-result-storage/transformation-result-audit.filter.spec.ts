import {
  ArgumentsHost,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';

import { TransformationResultAuditFilter } from './transformation-result-audit.filter';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import { TransformationResultAuditOutcome } from './transformation-result.enums';

const ACTOR = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const RECORD = '00000000-0000-4000-8000-000000000003';

describe('TransformationResultAuditFilter', () => {
  let audit: { record: jest.Mock };
  let filter: TransformationResultAuditFilter;
  let baseCatch: jest.SpyInstance;

  beforeEach(() => {
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    filter = new TransformationResultAuditFilter(
      audit as unknown as TransformationResultAuditService,
    );
    baseCatch = jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      new UnauthorizedException(),
      TransformationResultAuditOutcome.UNAUTHENTICATED,
    ],
    [new BadRequestException(), TransformationResultAuditOutcome.INVALID],
    [new ThrottlerException(), TransformationResultAuditOutcome.RATE_LIMITED],
  ])('maps pre-handler exceptions to audit outcomes', (exception, outcome) => {
    filter.catch(
      exception,
      hostFor({
        method: 'GET',
        url: `/api/transformations/history/${RECORD}/download`,
        user: { id: ACTOR, roles: [] },
      }),
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR,
        conversionRecordId: RECORD,
        targetUserId: null,
        outcome,
      }),
    );
  });

  it('extracts both target and record ids from the admin route', () => {
    filter.catch(
      new UnauthorizedException(),
      hostFor({
        method: 'GET',
        url: `/admin/users/${TARGET}/transformations/history/${RECORD}/download`,
      }),
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        targetUserId: TARGET,
        conversionRecordId: RECORD,
      }),
    );
  });

  it('does not persist malformed values into uuid audit columns', () => {
    filter.catch(
      new BadRequestException(),
      hostFor({
        method: 'GET',
        url: '/admin/users/not-a-uuid/transformations/history/bad/download',
      }),
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: null,
        conversionRecordId: null,
      }),
    );
  });

  it.each([
    ['GET', '/api/transformations/history'],
    ['GET', `/api/transformations/history/${RECORD}`],
    ['POST', `/api/transformations/history/${RECORD}/download`],
    ['GET', `/users/${TARGET}`],
  ])('ignores unrelated route %s %s', (method, url) => {
    filter.catch(new BadRequestException(), hostFor({ method, url }));

    expect(audit.record).not.toHaveBeenCalled();
    expect(baseCatch).toHaveBeenCalled();
  });

  it('always delegates response handling to Nest', () => {
    const exception = new UnauthorizedException();
    const host = hostFor({
      method: 'GET',
      url: `/api/transformations/history/${RECORD}/download`,
    });

    filter.catch(exception, host);

    expect(baseCatch).toHaveBeenCalledWith(exception, host);
  });
});

function hostFor(request: Record<string, unknown>): ArgumentsHost {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ArgumentsHost;
}
