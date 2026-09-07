import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import type { RequestUser } from '@/modules/auth/guards/jwt-auth.guard';
import { AccessConfigService } from '@/modules/rbac/access-config.service';

import { UserProfileAuditOutcome } from './entities/user-profile-audit-event.entity';
import { User, UserStatus } from './entities/user.entity';
import { UsersAuditService } from './users-audit.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let repository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    remove: jest.Mock;
  };
  let accessConfigService: { hasPermission: jest.Mock };
  let usersAuditService: { record: jest.Mock };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn(),
      create: jest.fn((data: Partial<User>) => data as User),
      save: jest.fn((user: User) =>
        Promise.resolve({ ...user, id: user.id ?? 'user-id' }),
      ),
      delete: jest.fn(),
      remove: jest.fn(),
    };
    accessConfigService = { hasPermission: jest.fn() };
    usersAuditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repository },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: UsersAuditService, useValue: usersAuditService },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('finds user by normalized email', async () => {
    const user = { id: '1', email: 'test@example.com' } as User;
    repository.findOne.mockResolvedValue(user);

    const result = await service.findByNormalizedEmail('test@example.com');
    expect(result).toBe(user);
  });

  it('creates an active user', async () => {
    const result = await service.create({
      email: 'new@example.com',
      passwordHash: 'hash',
      status: UserStatus.ACTIVE,
      confirmedAt: new Date(),
    });

    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(repository.save).toHaveBeenCalled();
  });

  it('activates a pending user', async () => {
    const user = {
      id: '1',
      status: UserStatus.PENDING_CONFIRMATION,
      pendingExpiresAt: new Date(),
    } as User;

    const result = await service.activate(user);
    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(result.confirmedAt).toBeInstanceOf(Date);
    expect(result.pendingExpiresAt).toBeNull();
  });

  describe('lockout helpers', () => {
    it('increments failed_login_attempts without locking below threshold', async () => {
      const user = {
        id: '1',
        failedLoginAttempts: 2,
        lockedUntil: null,
      } as User;

      const result = await service.recordFailedLogin(user);

      expect(result.failedLoginAttempts).toBe(3);
      expect(result.lockedUntil).toBeNull();
    });

    it('locks the account once the threshold is reached', async () => {
      const user = {
        id: '1',
        failedLoginAttempts: 4,
        lockedUntil: null,
      } as User;

      const now = new Date('2026-01-01T00:00:00.000Z');
      const result = await service.recordFailedLogin(user, now);

      expect(result.failedLoginAttempts).toBe(5);
      expect(result.lockedUntil).toEqual(
        new Date(now.getTime() + 15 * 60 * 1000),
      );
    });

    it('resets attempts and lock on success', async () => {
      const user = {
        id: '1',
        failedLoginAttempts: 5,
        lockedUntil: new Date(),
      } as User;

      const result = await service.recordSuccessfulLogin(user);

      expect(result.failedLoginAttempts).toBe(0);
      expect(result.lockedUntil).toBeNull();
    });

    it('reports lockout state via isLockedOut', () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const lockedUser = {
        lockedUntil: new Date(now.getTime() + 1000),
      } as User;
      const unlockedUser = { lockedUntil: null } as User;
      const expiredUser = {
        lockedUntil: new Date(now.getTime() - 1000),
      } as User;

      expect(service.isLockedOut(lockedUser, now)).toBe(true);
      expect(service.isLockedOut(unlockedUser, now)).toBe(false);
      expect(service.isLockedOut(expiredUser, now)).toBe(false);
    });
  });

  describe('getProfileFor', () => {
    const viewerId = 'e629655f-4f72-4ca9-a09a-9455261f15ec';
    const targetId = 'f495147f-5ef6-475d-9f62-16e3240a1d8b';

    const viewer = (roles: string[] = []): RequestUser => ({
      id: viewerId,
      roles,
    });

    const buildUser = (overrides: Partial<User> = {}): User =>
      ({
        id: viewerId,
        email: 'self@example.com',
        photoUrl: 'https://cdn.example.com/self.jpg',
        status: UserStatus.ACTIVE,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      }) as User;

    it('returns the full self-profile regardless of viewer roles', async () => {
      repository.findOne.mockResolvedValue(buildUser());

      const result = await service.getProfileFor(viewer(['nobody']), viewerId);

      expect(result).toEqual({
        id: viewerId,
        email: 'self@example.com',
        photo: 'https://cdn.example.com/self.jpg',
        status: UserStatus.ACTIVE,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        viewerId,
        UserProfileAuditOutcome.SELF_VIEW,
      );
    });

    it('throws NotFoundException when the self-lookup finds no user', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getProfileFor(viewer(), viewerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        viewerId,
        UserProfileAuditOutcome.NOT_FOUND,
      );
    });

    it('returns only id and photo for a privileged viewer of another user', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);
      repository.findOne.mockResolvedValue(
        buildUser({ id: targetId, photoUrl: 'https://cdn.example.com/t.jpg' }),
      );

      const result = await service.getProfileFor(viewer(['reader']), targetId);

      expect(result).toEqual({
        id: targetId,
        photo: 'https://cdn.example.com/t.jpg',
      });
      expect(accessConfigService.hasPermission).toHaveBeenCalledWith(
        ['reader'],
        'users',
        'read',
      );
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        targetId,
        UserProfileAuditOutcome.PRIVILEGED_VIEW,
      );
    });

    it('throws ForbiddenException without looking up the target when permission is missing', async () => {
      accessConfigService.hasPermission.mockReturnValue(false);

      await expect(
        service.getProfileFor(viewer(), targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        targetId,
        UserProfileAuditOutcome.DENIED,
      );
    });

    it('throws NotFoundException when a privileged viewer targets a nonexistent user', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getProfileFor(viewer(['reader']), targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        targetId,
        UserProfileAuditOutcome.NOT_FOUND,
      );
    });

    it('treats a malformed target id as not-found without querying the repository', async () => {
      accessConfigService.hasPermission.mockReturnValue(true);

      await expect(
        service.getProfileFor(viewer(['reader']), 'not-a-uuid'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(usersAuditService.record).toHaveBeenCalledWith(
        viewerId,
        'not-a-uuid',
        UserProfileAuditOutcome.NOT_FOUND,
      );
    });

    it('does not let a rejected audit call affect the returned result', async () => {
      usersAuditService.record.mockRejectedValueOnce(new Error('db down'));
      repository.findOne.mockResolvedValue(buildUser());

      const result = await service.getProfileFor(viewer(), viewerId);

      expect(result.id).toBe(viewerId);
    });
  });
});
