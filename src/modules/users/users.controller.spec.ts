import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';

import { AccountDeletionAuditService } from './account-deletion-audit.service';
import { AccountDeletionService } from './account-deletion.service';
import {
  AccountDeletionAuditAction,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';
import { ProfileAuditService } from './profile-audit.service';
import { UserDirectoryAuditOutcome } from './entities/user-directory-audit-event.entity';
import { UserDirectoryAuditService } from './user-directory-audit.service';
import { UserDirectoryService } from './user-directory.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { EmailChangeService } from './email-change.service';

describe('UsersController', () => {
  let controller: UsersController;
  let accessConfigService: { hasPermission: jest.Mock };
  let accountDeletionService: { adminDelete: jest.Mock };
  let accountDeletionAuditService: { record: jest.Mock };
  let userDirectoryService: { list: jest.Mock };
  let userDirectoryAuditService: { record: jest.Mock };

  function buildRequest(callerId: string, roles: string[] = []) {
    return { user: { id: callerId, roles } } as never;
  }

  beforeEach(async () => {
    accessConfigService = { hasPermission: jest.fn() };
    accountDeletionService = { adminDelete: jest.fn() };
    accountDeletionAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    userDirectoryService = { list: jest.fn() };
    userDirectoryAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: {} },
        { provide: EmailChangeService, useValue: {} },
        { provide: ProfileAuditService, useValue: { record: jest.fn() } },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: AccountDeletionService, useValue: accountDeletionService },
        {
          provide: AccountDeletionAuditService,
          useValue: accountDeletionAuditService,
        },
        { provide: UserDirectoryService, useValue: userDirectoryService },
        {
          provide: UserDirectoryAuditService,
          useValue: userDirectoryAuditService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UsersController);
  });

  describe('DELETE /users/:userId guard', () => {
    it('denies and audits DENIED when the caller lacks the delete action', async () => {
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        controller.adminDeleteUser('target-1', buildRequest('caller-1')),
      ).rejects.toThrow(ForbiddenException);

      expect(accountDeletionAuditService.record).toHaveBeenCalledWith(
        'caller-1',
        'target-1',
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.DENIED,
      );
      expect(accountDeletionService.adminDelete).not.toHaveBeenCalled();
    });

    it('denies and audits DENIED when the caller targets their own id even holding delete', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);

      await expect(
        controller.adminDeleteUser('caller-1', buildRequest('caller-1')),
      ).rejects.toThrow(ForbiddenException);

      expect(accountDeletionAuditService.record).toHaveBeenCalledWith(
        'caller-1',
        'caller-1',
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.DENIED,
      );
      expect(accountDeletionService.adminDelete).not.toHaveBeenCalled();
    });

    it('allows and audits SUCCESS when permission and self-target checks pass', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);
      accountDeletionService.adminDelete.mockResolvedValue({
        message: 'deleted',
        outcome: 'deleted',
      });

      const result = await controller.adminDeleteUser(
        'target-1',
        buildRequest('caller-1'),
      );

      expect(result).toEqual({ message: 'deleted' });
      expect(accountDeletionAuditService.record).toHaveBeenCalledWith(
        'caller-1',
        'target-1',
        AccountDeletionAuditAction.ADMIN_DELETE,
        AccountDeletionAuditOutcome.SUCCESS,
      );
    });
  });

  describe('GET /users guard', () => {
    it('denies, audits DENIED, and never calls UserDirectoryService.list when the caller lacks users.list', async () => {
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        controller.listUsers({}, buildRequest('caller-1', ['reader'])),
      ).rejects.toThrow(ForbiddenException);

      expect(accessConfigService.hasPermission).toHaveBeenCalledWith(
        ['reader'],
        'users',
        'list',
      );
      expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
        actorId: 'caller-1',
        outcome: UserDirectoryAuditOutcome.DENIED,
      });
      expect(userDirectoryService.list).not.toHaveBeenCalled();
    });

    it('lists and audits SUCCESS with resultCount and option-kind flags when permitted', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);
      const page = {
        items: [{ id: 'user-1' }, { id: 'user-2' }],
        nextCursor: null,
      };
      userDirectoryService.list.mockResolvedValue(page);

      const result = await controller.listUsers(
        { search: 'alice', status: undefined, sort: 'email' } as never,
        buildRequest('caller-1', ['admin']),
      );

      expect(result).toBe(page);
      expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
        actorId: 'caller-1',
        outcome: UserDirectoryAuditOutcome.SUCCESS,
        resultCount: 2,
        searchUsed: true,
        statusFilterUsed: false,
        sortField: 'email',
      });
    });

    it('defaults sortField to createdAt and flags to false when no options are supplied', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);
      userDirectoryService.list.mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      await controller.listUsers({}, buildRequest('caller-1', ['admin']));

      expect(userDirectoryAuditService.record).toHaveBeenCalledWith({
        actorId: 'caller-1',
        outcome: UserDirectoryAuditOutcome.SUCCESS,
        resultCount: 0,
        searchUsed: false,
        statusFilterUsed: false,
        sortField: 'createdAt',
      });
    });
  });
});
