import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User, UserStatus } from './entities/user.entity';
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repository },
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
});
