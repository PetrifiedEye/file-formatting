import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User, UserStatus } from '@/modules/users/entities/user.entity';

import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { hashSecret } from './utils/confirmation-token';

describe('SessionService', () => {
  let service: SessionService;
  let sessions: Partial<Session>[];

  const user: User = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: 'hash',
    status: UserStatus.ACTIVE,
    pendingExpiresAt: null,
    confirmedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
  };

  const repository = {
    create: jest.fn((data: Partial<Session>) => ({ id: 'session-1', ...data })),
    save: jest.fn((session: Partial<Session>) => {
      const saved = { ...session };
      sessions.push(saved);
      return Promise.resolve(saved);
    }),
    findOne: jest.fn(
      ({
        where,
      }: {
        where: { tokenHash: string; expiresAt: { value: Date } };
      }) => {
        const found = sessions.find((s) => {
          if (s.tokenHash !== where.tokenHash) return false;
          if (s.invalidatedAt !== null) return false;
          if (s.expiresAt! <= where.expiresAt.value) return false;
          return true;
        });
        return Promise.resolve(found ?? null);
      },
    ),
    update: jest.fn(
      (
        criteria: { id?: string; userId?: string; invalidatedAt?: unknown },
        partial: Partial<Session>,
      ) => {
        sessions = sessions.map((s) => {
          const matchesId = criteria.id ? s.id === criteria.id : true;
          const matchesUser = criteria.userId
            ? s.userId === criteria.userId
            : true;
          const matchesInvalidated =
            criteria.invalidatedAt !== undefined
              ? s.invalidatedAt === null
              : true;
          if (matchesId && matchesUser && matchesInvalidated) {
            return { ...s, ...partial };
          }
          return s;
        });
        return Promise.resolve({ affected: 1 });
      },
    ),
  };

  beforeEach(async () => {
    sessions = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: getRepositoryToken(Session), useValue: repository },
      ],
    }).compile();

    service = module.get(SessionService);
  });

  it('issues a session with a hashed token and 24h expiry', async () => {
    const { session, token } = await service.issue(
      user,
      '127.0.0.1',
      'jest-agent',
    );

    expect(token).toBeTruthy();
    expect(session.tokenHash).toBe(hashSecret(token));
    expect(session.expiresAt.getTime() - session.issuedAt.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it('validates an active, unexpired session by raw token', async () => {
    const { token } = await service.issue(user, null, null);

    const found = await service.validate(token);

    expect(found).not.toBeNull();
    expect(found?.userId).toBe(user.id);
  });

  it('returns null for an unknown token', async () => {
    const found = await service.validate('not-a-real-token');
    expect(found).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const { session, token } = await service.issue(user, null, null);
    session.expiresAt = new Date(Date.now() - 1000);

    const found = await service.validate(token);
    expect(found).toBeNull();
  });

  it('returns null for an invalidated session', async () => {
    const { session, token } = await service.issue(user, null, null);
    session.invalidatedAt = new Date();

    const found = await service.validate(token);
    expect(found).toBeNull();
  });

  it('invalidates a session by id', async () => {
    const { session, token } = await service.issue(user, null, null);

    await service.invalidate(session.id);

    const found = sessions.find((s) => s.id === session.id);
    expect(found?.invalidatedAt).not.toBeNull();
    void token;
  });

  it('invalidates all sessions for a user', async () => {
    await service.issue(user, null, null);
    await service.issue(user, null, null);

    await service.invalidateAllForUser(user.id);

    expect(sessions.every((s) => s.invalidatedAt !== null)).toBe(true);
  });
});
