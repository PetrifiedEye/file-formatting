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
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { EmailChangeService } from './email-change.service';

describe('UsersController', () => {
  let controller: UsersController;
  let accessConfigService: { hasPermission: jest.Mock };
  let accountDeletionService: { adminDelete: jest.Mock };
  let accountDeletionAuditService: { record: jest.Mock };

  function buildRequest(callerId: string, roles: string[] = []) {
    return { user: { id: callerId, roles } } as never;
  }

  beforeEach(async () => {
    accessConfigService = { hasPermission: jest.fn() };
    accountDeletionService = { adminDelete: jest.fn() };
    accountDeletionAuditService = {
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
});
