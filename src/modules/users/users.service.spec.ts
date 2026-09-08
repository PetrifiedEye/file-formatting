import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConfigService } from '@/core/config/config.service';
import { LocalFileStorageService } from '@/core/storage/local-file-storage.service';
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
  let storageService: { save: jest.Mock; delete: jest.Mock };
  let configService: { get: jest.Mock };

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
    storageService = {
      save: jest.fn().mockResolvedValue('photos/new-uuid.jpg'),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    configService = {
      get: jest.fn().mockReturnValue('http://localhost:3007'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repository },
        { provide: AccessConfigService, useValue: accessConfigService },
        { provide: UsersAuditService, useValue: usersAuditService },
        { provide: LocalFileStorageService, useValue: storageService },
        { provide: ConfigService, useValue: configService },
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

  describe('updatePhoto', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

    it('stores the file, updates photoUrl, and deletes the previous photo', async () => {
      const user = {
        id: 'user-1',
        photoUrl: 'http://localhost:3007/assets/photos/old-uuid.png',
      } as User;
      repository.findOne.mockResolvedValue(user);

      const result = await service.updatePhoto('user-1', jpegBuffer);

      expect(storageService.save).toHaveBeenCalledWith(jpegBuffer, 'jpg');
      expect(result.photoUrl).toBe(
        'http://localhost:3007/assets/photos/new-uuid.jpg',
      );
      expect(repository.save).toHaveBeenCalled();
      expect(storageService.delete).toHaveBeenCalledWith('photos/old-uuid.png');
    });

    it('does not attempt to delete when there was no previous photo', async () => {
      repository.findOne.mockResolvedValue({
        id: 'user-1',
        photoUrl: null,
      } as User);

      await service.updatePhoto('user-1', jpegBuffer);

      expect(storageService.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePhoto('missing', jpegBuffer),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storageService.save).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for a file with no recognizable image signature', async () => {
      repository.findOne.mockResolvedValue({ id: 'user-1' } as User);

      await expect(
        service.updatePhoto('user-1', Buffer.from('not an image')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storageService.save).not.toHaveBeenCalled();
    });
  });

  describe('updateEmailDirect', () => {
    it('updates the email immediately', async () => {
      const user = { id: 'user-1', email: 'old@example.com' } as User;
      repository.findOne
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(null);

      const result = await service.updateEmailDirect(
        'user-1',
        'new@example.com',
      );

      expect(result.email).toBe('new@example.com');
      expect(repository.save).toHaveBeenCalled();
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.updateEmailDirect('missing', 'new@example.com'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ConflictException when the email is already used by another account', async () => {
      const user = { id: 'user-1', email: 'old@example.com' } as User;
      const other = { id: 'user-2', email: 'new@example.com' } as User;
      repository.findOne
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(other);

      await expect(
        service.updateEmailDirect('user-1', 'new@example.com'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
