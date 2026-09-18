import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';
import {
  ImageFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { AccessConfigService } from '@/modules/rbac/access-config.service';
import { User } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { TransformationHistoryItemDto } from './dto/transformation-history-item.dto';
import { TransformationHistoryPageDto } from './dto/transformation-history-page.dto';
import { TransformationHistoryQueryDto } from './dto/transformation-history-query.dto';
import { TransformationHistoryAuditOutcome } from './entities/transformation-history-audit-event.entity';
import { TransformationHistoryAuditService } from './transformation-history-audit.service';
import { TransformationHistoryController } from './transformation-history.controller';
import { TransformationHistoryService } from './transformation-history.service';

const CALLER = '00000000-0000-4000-8000-0000000000aa';
const TARGET = '00000000-0000-4000-8000-0000000000bb';

interface RequestWithUser extends FastifyRequest {
  user: RequestUser;
}

const EMPTY_PAGE: TransformationHistoryPageDto = {
  items: [],
  nextCursor: null,
};

function requestFor(id: string, roles: string[] = []): RequestWithUser {
  return { user: { id, roles } } as RequestWithUser;
}

describe('TransformationHistoryController', () => {
  let historyService: { getHistory: jest.Mock };
  let accessConfigService: { hasPermission: jest.Mock };
  let usersService: { findById: jest.Mock };
  let auditService: { record: jest.Mock };
  let controller: TransformationHistoryController;

  beforeEach(() => {
    historyService = {
      getHistory: jest.fn().mockResolvedValue(EMPTY_PAGE),
    };
    accessConfigService = { hasPermission: jest.fn().mockReturnValue(true) };
    usersService = {
      findById: jest.fn().mockResolvedValue({ id: TARGET } as User),
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    controller = new TransformationHistoryController(
      historyService as unknown as TransformationHistoryService,
      accessConfigService as unknown as AccessConfigService,
      usersService as unknown as UsersService,
      auditService as unknown as TransformationHistoryAuditService,
    );
  });

  describe('the self route (US1)', () => {
    it('reads the caller s own id, never one supplied by the request', async () => {
      const query: TransformationHistoryQueryDto = { limit: 10 };

      await controller.getOwnHistory(query, requestFor(CALLER));

      expect(historyService.getHistory).toHaveBeenCalledWith(CALLER, query);
      expect(historyService.getHistory).not.toHaveBeenCalledWith(
        TARGET,
        expect.anything(),
      );
    });

    it('returns the service s page unchanged', async () => {
      const page: TransformationHistoryPageDto = {
        items: [],
        nextCursor: 'opaque',
      };
      historyService.getHistory.mockResolvedValue(page);

      await expect(
        controller.getOwnHistory({}, requestFor(CALLER)),
      ).resolves.toBe(page);
    });

    it('succeeds for a caller holding no permissions at all (US3)', async () => {
      // FR-001: the self route consults no permission, so it cannot be
      // switched off for a user by revoking one.
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        controller.getOwnHistory({}, requestFor(CALLER)),
      ).resolves.toBe(EMPTY_PAGE);
      expect(accessConfigService.hasPermission).not.toHaveBeenCalled();
    });
  });

  describe('the admin route (US2)', () => {
    it('reads the target s history when the permission is held and the user exists', async () => {
      const query: TransformationHistoryQueryDto = { limit: 5 };

      await expect(
        controller.getUserHistory(TARGET, query, requestFor(CALLER, ['admin'])),
      ).resolves.toBe(EMPTY_PAGE);

      expect(accessConfigService.hasPermission).toHaveBeenCalledWith(
        ['admin'],
        'transformation-history',
        'read-any',
      );
      expect(historyService.getHistory).toHaveBeenCalledWith(TARGET, query);
    });

    it('throws NotFound when the permission is held but the user does not exist', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        controller.getUserHistory(TARGET, {}, requestFor(CALLER, ['admin'])),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(historyService.getHistory).not.toHaveBeenCalled();
    });
  });

  describe('the authorization boundary (US3)', () => {
    it('refuses without the permission, and never asks whether the target exists', async () => {
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        controller.getUserHistory(TARGET, {}, requestFor(CALLER, ['plain'])),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The ordering is the point: a 404 reachable before the permission check
      // would answer "does this account exist?" for a caller who may not ask.
      expect(usersService.findById).not.toHaveBeenCalled();
      expect(historyService.getHistory).not.toHaveBeenCalled();
    });
  });

  describe('the audit trail (US6)', () => {
    const NO_FILTERS = {
      typeFilterUsed: false,
      sourceFormatFilterUsed: false,
      targetFormatFilterUsed: false,
      statusFilterUsed: false,
      dateRangeFilterUsed: false,
    };

    it('records a self read with its result count and no target', async () => {
      historyService.getHistory.mockResolvedValue({
        items: [{}, {}, {}] as TransformationHistoryItemDto[],
        nextCursor: null,
      });

      await controller.getOwnHistory({}, requestFor(CALLER));

      expect(auditService.record).toHaveBeenCalledWith({
        actorUserId: CALLER,
        outcome: TransformationHistoryAuditOutcome.SUCCESS,
        resultCount: 3,
        ...NO_FILTERS,
      });
    });

    it('records an admin read with the target and its result count', async () => {
      historyService.getHistory.mockResolvedValue({
        items: [{}] as TransformationHistoryItemDto[],
        nextCursor: null,
      });

      await controller.getUserHistory(
        TARGET,
        {},
        requestFor(CALLER, ['admin']),
      );

      expect(auditService.record).toHaveBeenCalledWith({
        actorUserId: CALLER,
        targetUserId: TARGET,
        outcome: TransformationHistoryAuditOutcome.SUCCESS,
        resultCount: 1,
        ...NO_FILTERS,
      });
    });

    it('records a denial', async () => {
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        controller.getUserHistory(TARGET, {}, requestFor(CALLER, ['plain'])),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(auditService.record).toHaveBeenCalledWith({
        actorUserId: CALLER,
        targetUserId: TARGET,
        outcome: TransformationHistoryAuditOutcome.DENIED,
        ...NO_FILTERS,
      });
    });

    it('records a not-found, with no result count', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(
        controller.getUserHistory(TARGET, {}, requestFor(CALLER, ['admin'])),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(auditService.record).toHaveBeenCalledWith({
        actorUserId: CALLER,
        targetUserId: TARGET,
        outcome: TransformationHistoryAuditOutcome.NOT_FOUND,
        ...NO_FILTERS,
      });
    });

    it('records which filter kinds were used, never their values', async () => {
      await controller.getOwnHistory(
        {
          type: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          createdAtFrom: '2026-09-01T00:00:00.000Z',
        },
        requestFor(CALLER),
      );

      const [recorded] = auditService.record.mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(recorded).toMatchObject({
        typeFilterUsed: true,
        sourceFormatFilterUsed: true,
        targetFormatFilterUsed: false,
        statusFilterUsed: false,
        dateRangeFilterUsed: true,
      });

      const serialized = JSON.stringify(recorded);
      expect(serialized).not.toContain('image');
      expect(serialized).not.toContain('png');
      expect(serialized).not.toContain('2026-09-01');
    });

    it('records a date range when only one bound was supplied', async () => {
      await controller.getOwnHistory(
        { createdAtTo: '2026-09-30T00:00:00.000Z' },
        requestFor(CALLER),
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ dateRangeFilterUsed: true }),
      );
    });
  });
});
