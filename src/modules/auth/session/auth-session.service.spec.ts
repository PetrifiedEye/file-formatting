import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';

import {
  AuthSession,
  SessionRevocationReason,
} from '@/modules/auth/entities/auth-session.entity';

import { AuthSessionService } from './auth-session.service';
import { REFRESH_TOKEN_TTL_MS } from './token.service';

describe('AuthSessionService', () => {
  let service: AuthSessionService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      create: jest.fn((data: Partial<AuthSession>) => data),
      save: jest.fn((session: Partial<AuthSession>) =>
        Promise.resolve({ id: 'session-1', ...session }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthSessionService,
        { provide: getRepositoryToken(AuthSession), useValue: repository },
      ],
    }).compile();

    service = module.get(AuthSessionService);
  });

  it('opens a session that lives exactly as long as a refresh token', async () => {
    const before = Date.now();

    const session = await service.start('user-1');

    expect(session).toMatchObject({
      id: 'session-1',
      userId: 'user-1',
      revokedAt: null,
      revokedReason: null,
    });
    expect(session.expiresAt.getTime() - session.lastUsedAt.getTime()).toBe(
      REFRESH_TOKEN_TTL_MS,
    );
    expect(session.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('finds only a session that is the user s, unrevoked and unexpired', async () => {
    await service.findActive('session-1', 'user-1');

    const [{ where }] = repository.findOne.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where.id).toBe('session-1');
    expect(where.userId).toBe('user-1');
    expect(where.revokedAt).toBeInstanceOf(FindOperator);
    expect((where.revokedAt as FindOperator<unknown>).type).toBe('isNull');
    expect((where.expiresAt as FindOperator<unknown>).type).toBe('moreThan');
  });

  it('touches the last-used time', async () => {
    await service.touch('session-1');

    expect(repository.update).toHaveBeenCalledWith(
      { id: 'session-1' },
      { lastUsedAt: expect.any(Date) as Date },
    );
  });

  it('revokes a session only if it is not revoked already', async () => {
    await service.revoke('session-1', SessionRevocationReason.LOGOUT);

    const [criteria, changes] = repository.update.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // The first revocation's time and reason are the ones that stand.
    expect(criteria.id).toBe('session-1');
    expect((criteria.revokedAt as FindOperator<unknown>).type).toBe('isNull');
    expect(changes).toEqual({
      revokedAt: expect.any(Date) as Date,
      revokedReason: SessionRevocationReason.LOGOUT,
    });
  });

  it('revokes every live session of a user and says how many', async () => {
    repository.update.mockResolvedValue({ affected: 3 });

    await expect(
      service.revokeAllForUser(
        'user-1',
        SessionRevocationReason.PASSWORD_RESET,
      ),
    ).resolves.toBe(3);

    const [criteria] = repository.update.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(criteria.userId).toBe('user-1');
    expect((criteria.revokedAt as FindOperator<unknown>).type).toBe('isNull');
  });

  it('reports zero when the driver does not say', async () => {
    repository.update.mockResolvedValue({});

    await expect(
      service.revokeAllForUser('user-1', SessionRevocationReason.LOGOUT),
    ).resolves.toBe(0);
  });
});
