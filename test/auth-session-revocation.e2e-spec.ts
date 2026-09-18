import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { createHash } from 'crypto';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import {
  AuthSession,
  SessionRevocationReason,
} from '../src/modules/auth/entities/auth-session.entity';
import { PasswordResetChallenge } from '../src/modules/auth/entities/password-reset-challenge.entity';
import { LoginAuditEvent } from '../src/modules/auth/entities/login-audit-event.entity';
import { SystemSettings } from '../src/modules/settings/entities/system-settings.entity';
import { User } from '../src/modules/users/entities/user.entity';

const TEST_PASSWORD = 'CorrectHorse123!';
const NEW_PASSWORD = 'BrandNewHorse456!';

function extractCookie(
  setCookieHeader: string[] | undefined,
  name: string,
): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith(`${name}=`),
  );
  if (!cookie) {
    throw new Error(`No ${name} cookie found in response`);
  }
  return cookie.split(';')[0];
}

// Yields every 2000 iterations: run flat-out, this blocks the event loop for
// hundreds of ms, which is long enough to starve a keep-alive HTTP socket
// mid-suite and surface as ECONNRESET or an HTTP parse error in an unrelated
// request.
async function bruteForceOtp(otpHash: string): Promise<string> {
  for (let i = 100000; i < 1000000; i += 1) {
    const code = i.toString();
    if (createHash('sha256').update(code).digest('hex') === otpHash) {
      return code;
    }
    if (i % 2000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw new Error('Could not recover OTP from hash');
}

/**
 * Covers the session-revocation half of authentication: before it existed,
 * both access and refresh tokens were stateless, so a refresh token survived
 * logout and a password reset for its full 30-day lifetime.
 */
describe('Auth session revocation (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let userRepository: Repository<User>;
  let sessionRepository: Repository<AuthSession>;
  let resetChallengeRepository: Repository<PasswordResetChallenge>;
  let loginAuditRepository: Repository<LoginAuditEvent>;
  let settingsRepository: Repository<SystemSettings>;
  let throttlerStorage: ThrottlerStorageService;

  let email: string;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    const configService = moduleFixture.get(ConfigService);
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyCookie, {
        secret: configService.get('COOKIE_SECRET'),
      });

    await app.init();
    // Listen for real: concurrent supertest calls against one un-listened
    // server object interleave onto the same ephemeral socket and produce
    // bogus parse errors.
    await app.listen(0, '127.0.0.1');
    await app.getHttpAdapter().getInstance().ready();
    baseUrl = await app.getUrl();

    userRepository = moduleFixture.get(getRepositoryToken(User));
    sessionRepository = moduleFixture.get(getRepositoryToken(AuthSession));
    resetChallengeRepository = moduleFixture.get(
      getRepositoryToken(PasswordResetChallenge),
    );
    loginAuditRepository = moduleFixture.get(
      getRepositoryToken(LoginAuditEvent),
    );
    settingsRepository = moduleFixture.get(getRepositoryToken(SystemSettings));
    throttlerStorage = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();

    await loginAuditRepository.createQueryBuilder().delete().execute();
    await resetChallengeRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    await settingsRepository.update(1, {
      registrationConfirmationEnabled: false,
      passwordRecoveryConfirmationEnabled: true,
      signInConfirmationEnabled: false,
      passwordMinLength: 8,
    });

    email = `session-${Date.now()}-${Math.random()}@example.com`;
    await request(baseUrl)
      .post('/auth/register')
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
  });

  async function signIn(): Promise<{ access: string; refresh: string }> {
    const response = await request(baseUrl)
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    const setCookie = response.headers['set-cookie'] as unknown as string[];
    return {
      access: extractCookie(setCookie, 'access_token'),
      refresh: extractCookie(setCookie, 'refresh_token'),
    };
  }

  it('opens one session row per sign-in', async () => {
    await signIn();
    await signIn();

    const user = await userRepository.findOneOrFail({ where: { email } });
    const sessions = await sessionRepository.find({
      where: { userId: user.id },
    });

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revokedAt === null)).toBe(true);
  });

  describe('logout', () => {
    it('revokes the session, so the refresh token stops working', async () => {
      const { access, refresh } = await signIn();

      await request(baseUrl)
        .post('/auth/refresh')
        .set('Cookie', refresh)
        .expect(200);

      await request(baseUrl)
        .post('/auth/logout')
        .set('Cookie', `${access}; ${refresh}`)
        .expect(200);

      // The token itself is still cryptographically valid and unexpired; only
      // the session behind it is gone.
      await request(baseUrl)
        .post('/auth/refresh')
        .set('Cookie', refresh)
        .expect(401);

      await request(baseUrl)
        .get('/auth/session')
        .set('Cookie', access)
        .expect(401);

      const user = await userRepository.findOneOrFail({ where: { email } });
      const [session] = await sessionRepository.find({
        where: { userId: user.id },
      });
      expect(session.revokedReason).toBe(SessionRevocationReason.LOGOUT);
    });

    it('leaves the user other sessions alone', async () => {
      const first = await signIn();
      const second = await signIn();

      await request(baseUrl)
        .post('/auth/logout')
        .set('Cookie', `${first.access}; ${first.refresh}`)
        .expect(200);

      await request(baseUrl)
        .get('/auth/session')
        .set('Cookie', second.access)
        .expect(200);
    });

    it('still reports success when called without a session cookie', async () => {
      await request(baseUrl).post('/auth/logout').expect(200);
    });
  });

  describe('password reset', () => {
    it('revokes every session opened with the old password', async () => {
      const phone = await signIn();
      const laptop = await signIn();

      await request(baseUrl)
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);

      const user = await userRepository.findOneOrFail({ where: { email } });
      const challenge = await resetChallengeRepository.findOneOrFail({
        where: { userId: user.id },
      });

      const code = await bruteForceOtp(challenge.otpHash);

      await request(baseUrl)
        .post('/auth/password-reset/confirm')
        .send({
          email,
          code,
          newPassword: NEW_PASSWORD,
        })
        .expect(200);

      // Both devices are signed out — this is the whole point of a reset after
      // a credential compromise.
      await request(baseUrl)
        .get('/auth/session')
        .set('Cookie', phone.access)
        .expect(401);
      await request(baseUrl)
        .post('/auth/refresh')
        .set('Cookie', laptop.refresh)
        .expect(401);

      const sessions = await sessionRepository.find({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(2);
      expect(
        sessions.every(
          (session) =>
            session.revokedReason === SessionRevocationReason.PASSWORD_RESET,
        ),
      ).toBe(true);

      // The new password still opens a working session.
      const after = await request(baseUrl)
        .post('/auth/login')
        .send({ email, password: NEW_PASSWORD })
        .expect(200);

      await request(baseUrl)
        .get('/auth/session')
        .set(
          'Cookie',
          extractCookie(
            after.headers['set-cookie'] as unknown as string[],
            'access_token',
          ),
        )
        .expect(200);
    });
  });

  describe('refresh', () => {
    it('keeps the caller in the same session it renews', async () => {
      const { refresh } = await signIn();
      const user = await userRepository.findOneOrFail({ where: { email } });

      const renewed = await request(baseUrl)
        .post('/auth/refresh')
        .set('Cookie', refresh)
        .expect(200);

      const sessions = await sessionRepository.find({
        where: { userId: user.id },
      });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].revokedAt).toBeNull();

      await request(baseUrl)
        .get('/auth/session')
        .set(
          'Cookie',
          extractCookie(
            renewed.headers['set-cookie'] as unknown as string[],
            'access_token',
          ),
        )
        .expect(200);
    });

    it('rejects a refresh token whose session was revoked out of band', async () => {
      const { refresh } = await signIn();
      const user = await userRepository.findOneOrFail({ where: { email } });

      await sessionRepository.update(
        { userId: user.id },
        {
          revokedAt: new Date(),
          revokedReason: SessionRevocationReason.LOGOUT,
        },
      );

      await request(baseUrl)
        .post('/auth/refresh')
        .set('Cookie', refresh)
        .expect(401);
    });
  });
});
