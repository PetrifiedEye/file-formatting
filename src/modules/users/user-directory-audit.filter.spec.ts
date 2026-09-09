import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';

import { UserDirectoryAuditOutcome } from './entities/user-directory-audit-event.entity';
import { UserDirectoryAuditFilter } from './user-directory-audit.filter';

describe('UserDirectoryAuditFilter', () => {
  let filter: UserDirectoryAuditFilter;
  let userDirectoryAuditService: { record: jest.Mock };

  function buildHost(
    request: Partial<{ method: string; url: string; user?: { id: string } }>,
  ): ArgumentsHost {
    const response = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
  }

  beforeEach(() => {
    userDirectoryAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    filter = new UserDirectoryAuditFilter(userDirectoryAuditService as never);
    // BaseExceptionFilter.catch() reaches for the underlying HTTP adapter;
    // stub it out so these tests exercise only the audit side-effect.
    jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  it('records UNAUTHENTICATED for a 401 on GET /users', () => {
    const host = buildHost({ method: 'GET', url: '/users?limit=20' });

    filter.catch(new UnauthorizedException('Authentication required'), host);

    expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
      actorId: null,
      outcome: UserDirectoryAuditOutcome.UNAUTHENTICATED,
    });
  });

  it('records RATE_LIMITED for a 429 on GET /users', () => {
    const host = buildHost({
      method: 'GET',
      url: '/users',
      user: { id: 'actor-1' },
    });

    filter.catch(new ThrottlerException(), host);

    expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
      actorId: 'actor-1',
      outcome: UserDirectoryAuditOutcome.RATE_LIMITED,
    });
  });

  it('records INVALID for a 400 on GET /users', () => {
    const host = buildHost({ method: 'GET', url: '/users?limit=0' });

    filter.catch(new BadRequestException('Invalid'), host);

    expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
      actorId: null,
      outcome: UserDirectoryAuditOutcome.INVALID,
    });
  });

  it('ignores a request for a different path', () => {
    const host = buildHost({ method: 'GET', url: '/users/some-id' });

    filter.catch(new UnauthorizedException(), host);

    expect(userDirectoryAuditService.record).not.toHaveBeenCalled();
  });

  it('ignores a non-GET method on the collection path', () => {
    const host = buildHost({ method: 'POST', url: '/users' });

    filter.catch(new BadRequestException(), host);

    expect(userDirectoryAuditService.record).not.toHaveBeenCalled();
  });

  it('does not change the HTTP outcome when the audit write fails', () => {
    userDirectoryAuditService.record.mockRejectedValueOnce(
      new Error('db down'),
    );
    const host = buildHost({ method: 'GET', url: '/users' });

    expect(() => filter.catch(new UnauthorizedException(), host)).not.toThrow();
  });
});
