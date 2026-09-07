import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { createHash } from 'crypto';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { LoginChallenge } from '../src/modules/auth/entities/login-challenge.entity';
import { PasswordResetChallenge } from '../src/modules/auth/entities/password-reset-challenge.entity';
import { LoginAuditEvent } from '../src/modules/auth/entities/login-audit-event.entity';
import { SystemSettings } from '../src/modules/settings/entities/system-settings.entity';

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

function extractAuthCookies(setCookieHeader: string[] | undefined): string {
  const access = extractCookie(setCookieHeader, 'access_token');
  const refresh = extractCookie(setCookieHeader, 'refresh_token');
  return `${access}; ${refresh}`;
}

function bruteForceOtp(otpHash: string): string {
  for (let i = 100000; i < 1000000; i += 1) {
    const code = i.toString();
    const hash = createHash('sha256').update(code).digest('hex');
    if (hash === otpHash) {
      return code;
    }
  }
  throw new Error('Could not recover OTP from hash');
}

describe('Auth Login (e2e)', () => {
  let app: INestApplication<App>;
  let usersRepository: Repository<User>;
  let loginChallengeRepository: Repository<LoginChallenge>;
  let passwordResetChallengeRepository: Repository<PasswordResetChallenge>;
  let loginAuditRepository: Repository<LoginAuditEvent>;
  let settingsRepository: Repository<SystemSettings>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const fastifyApp =
      moduleFixture.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
      );
    app = fastifyApp;

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    const configService = moduleFixture.get(ConfigService);
    await fastifyApp.register(fastifyCookie, {
      secret: configService.get('COOKIE_SECRET'),
    });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    usersRepository = moduleFixture.get(getRepositoryToken(User));
    loginChallengeRepository = moduleFixture.get(
      getRepositoryToken(LoginChallenge),
    );
    passwordResetChallengeRepository = moduleFixture.get(
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

  function clearThrottler() {
    // Also cancel pending expiration timeouts scheduled by the throttler
    // storage — clearing the map alone leaves stale timers that later crash
    // trying to read the (now-missing) record they reference.
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
  }

  beforeEach(async () => {
    clearThrottler();

    await loginChallengeRepository.createQueryBuilder().delete().execute();
    await passwordResetChallengeRepository
      .createQueryBuilder()
      .delete()
      .execute();
    await loginAuditRepository.createQueryBuilder().delete().execute();
    await usersRepository.createQueryBuilder().delete().execute();

    await settingsRepository.update(1, {
      registrationConfirmationEnabled: false,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
    });
  });

  async function registerActiveUser(email: string, password: string) {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
  }

  describe('Login', () => {
    it('logs in with correct credentials and issues access/refresh cookies', async () => {
      const email = `login1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      expect(loginResponse.body).toEqual({
        message: 'Signed in.',
        verificationRequired: false,
      });

      const setCookie = loginResponse.headers['set-cookie'] as unknown as
        | string[]
        | undefined;
      const accessCookie = extractCookie(setCookie, 'access_token');
      const refreshCookie = extractCookie(setCookie, 'refresh_token');
      expect(accessCookie).toContain('access_token=');
      expect(refreshCookie).toContain('refresh_token=');

      const cookies = `${accessCookie}; ${refreshCookie}`;

      const logoutResponse = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', cookies)
        .expect(200);

      expect(logoutResponse.body.message).toBe('Signed out.');

      await request(app.getHttpServer()).post('/auth/logout').expect(200);
    });

    it('rejects wrong password with a generic 401', async () => {
      const email = `login2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'wrong-password' })
        .expect(401);

      expect(response.body.message).toBe('Invalid email or password.');
    });

    it('rejects unknown email with the identical generic 401', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: `nobody-${Date.now()}@example.com`,
          password: 'whatever1',
        })
        .expect(401);

      expect(response.body.message).toBe('Invalid email or password.');
    });

    it('rejects login against an unconfirmed account', async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: true,
      });

      const email = `login3-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      expect(user.status).toBe(UserStatus.PENDING_CONFIRMATION);

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(403);

      expect(response.body.canResend).toBe(true);
    });
  });

  describe('Sign-in verification', () => {
    beforeEach(async () => {
      await settingsRepository.update(1, { signInConfirmationEnabled: true });
    });

    it('requires verification and issues no cookie until confirmed', async () => {
      const email = `verify1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      expect(loginResponse.body).toEqual({
        message: 'Enter the code sent to your email to finish signing in.',
        verificationRequired: true,
      });
      expect(loginResponse.headers['set-cookie']).toBeUndefined();
    });

    it('disabled flow completes login immediately', async () => {
      await settingsRepository.update(1, { signInConfirmationEnabled: false });

      const email = `verify2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      expect(loginResponse.body.verificationRequired).toBe(false);
      expect(loginResponse.headers['set-cookie']).toBeDefined();
    });

    it('completes sign-in with the correct code within the window', async () => {
      const email = `verify3-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      const challenge = await loginChallengeRepository.findOneOrFail({
        where: { userId: user.id },
      });
      const code = bruteForceOtp(challenge.otpHash);

      const verifyResponse = await request(app.getHttpServer())
        .post('/auth/login/verify')
        .send({ email, code })
        .expect(200);

      expect(verifyResponse.body.message).toBe('Signed in.');
      const setCookie = verifyResponse.headers['set-cookie'] as unknown as
        | string[]
        | undefined;
      expect(extractCookie(setCookie, 'access_token')).toContain(
        'access_token=',
      );
      expect(extractCookie(setCookie, 'refresh_token')).toContain(
        'refresh_token=',
      );
    });

    it('rejects an expired verification code', async () => {
      const email = `verify4-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      await loginChallengeRepository.manager.query(
        `UPDATE login_challenges SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
        [user.id],
      );

      const response = await request(app.getHttpServer())
        .post('/auth/login/verify')
        .send({ email, code: '000000' })
        .expect(400);

      expect(response.body.message).toBe(
        'Unable to verify sign-in. Please check your code or start over.',
      );
    });

    it('rejects once attempts are exhausted', async () => {
      const email = `verify5-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login/verify')
          .send({ email, code: '000000' })
          .expect(400);
        clearThrottler();
      }

      const response = await request(app.getHttpServer())
        .post('/auth/login/verify')
        .send({ email, code: '000000' })
        .expect(400);

      expect(response.body.message).toBe(
        'Unable to verify sign-in. Please check your code or start over.',
      );
    });
  });

  describe('Lockout', () => {
    it('locks the account after 5 failed attempts and records every attempt', async () => {
      const email = `lockout1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'wrong-password' })
          .expect(401);
        clearThrottler();
      }

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(423);

      expect(response.body.message).toBe(
        'Too many failed attempts. Try again later.',
      );

      const user = await usersRepository.findOneOrFail({ where: { email } });
      const events = await loginAuditRepository.find({
        where: { userId: user.id },
      });
      expect(events.length).toBe(6);
    });

    it('clears the lockout once locked_until has elapsed', async () => {
      const email = `lockout2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email, password: 'wrong-password' })
          .expect(401);
        clearThrottler();
      }

      await usersRepository.update(
        { email },
        { lockedUntil: new Date(Date.now() - 1000) },
      );

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
    });
  });

  describe('Password reset', () => {
    beforeEach(async () => {
      await settingsRepository.update(1, {
        passwordRecoveryConfirmationEnabled: true,
      });
    });

    it('returns the identical generic body for existing and non-existing emails', async () => {
      const email = `reset1-${Date.now()}@example.com`;
      await registerActiveUser(email, 'CorrectHorse123!');

      const existingResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);

      clearThrottler();

      const unknownResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email: `nobody-${Date.now()}@example.com` })
        .expect(200);

      expect(existingResponse.body).toEqual(unknownResponse.body);
      expect(existingResponse.body.message).toContain(
        'If this email is registered',
      );
    });

    it('confirms with a valid code and changes the password', async () => {
      const email = `reset2-${Date.now()}@example.com`;
      const oldPassword = 'CorrectHorse123!';
      const newPassword = 'NewCorrectHorse456!';
      await registerActiveUser(email, oldPassword);

      await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      const challenge = await passwordResetChallengeRepository.findOneOrFail({
        where: { userId: user.id },
      });
      const code = bruteForceOtp(challenge.otpHash);

      const confirmResponse = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ email, code, newPassword })
        .expect(200);

      expect(confirmResponse.body.message).toContain('reset');

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: oldPassword })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: newPassword })
        .expect(200);
    });

    it('rejects an expired or already-used code without changing the password', async () => {
      const email = `reset3-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      await request(app.getHttpServer())
        .post('/auth/password-reset/request')
        .send({ email })
        .expect(200);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      await passwordResetChallengeRepository.manager.query(
        `UPDATE password_reset_challenges SET expires_at = now() - interval '1 hour' WHERE user_id = $1`,
        [user.id],
      );

      const response = await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ email, code: '000000', newPassword: 'AnotherPassword1!' })
        .expect(400);

      expect(response.body.message).toContain('Unable to reset password');

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
    });
  });

  describe('Route protection (JwtAuthGuard)', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await request(app.getHttpServer()).get('/rbac/roles').expect(401);
    });

    it('rejects a tampered access token cookie with 401', async () => {
      await request(app.getHttpServer())
        .get('/rbac/roles')
        .set('Cookie', 'access_token=garbage')
        .expect(401);
    });

    it('rejects a valid non-admin session with 403', async () => {
      const email = `protect1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const cookies = extractAuthCookies(
        loginResponse.headers['set-cookie'] as unknown as string[],
      );

      await request(app.getHttpServer())
        .get('/rbac/roles')
        .set('Cookie', cookies)
        .expect(403);
    });

    it('rejects a deactivated user even with a still-valid access token', async () => {
      const email = `protect2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const cookies = extractAuthCookies(
        loginResponse.headers['set-cookie'] as unknown as string[],
      );

      await usersRepository.update(
        { email },
        { status: UserStatus.PENDING_CONFIRMATION },
      );

      await request(app.getHttpServer())
        .get('/rbac/roles')
        .set('Cookie', cookies)
        .expect(401);
    });
  });

  describe('Session renewal (/auth/refresh)', () => {
    it('rotates access and refresh tokens for a valid refresh cookie', async () => {
      const email = `refresh1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const refreshCookie = extractCookie(
        loginResponse.headers['set-cookie'] as unknown as string[],
        'refresh_token',
      );

      const refreshResponse = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', refreshCookie)
        .expect(200);

      expect(refreshResponse.body).toEqual({ message: 'Session refreshed.' });
      const newSetCookie = refreshResponse.headers['set-cookie'] as unknown as
        | string[]
        | undefined;
      const newAccessCookie = extractCookie(newSetCookie, 'access_token');
      const newRefreshCookie = extractCookie(newSetCookie, 'refresh_token');

      await request(app.getHttpServer())
        .get('/rbac/roles')
        .set('Cookie', `${newAccessCookie}; ${newRefreshCookie}`)
        .expect(403); // authenticated (non-admin), proving the new access token works
    });

    it('rejects a missing refresh cookie with 401 and sets no cookies', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .expect(401);

      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 401,
          message: 'Authentication required',
        }),
      );
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a malformed refresh cookie with 401 and sets no cookies', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'refresh_token=garbage')
        .expect(401);

      expect(response.body).toEqual(
        expect.objectContaining({
          statusCode: 401,
          message: 'Authentication required',
        }),
      );
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('rejects a deactivated user even with a valid refresh token', async () => {
      const email = `refresh2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const refreshCookie = extractCookie(
        loginResponse.headers['set-cookie'] as unknown as string[],
        'refresh_token',
      );

      await usersRepository.update(
        { email },
        { status: UserStatus.PENDING_CONFIRMATION },
      );

      const response = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', refreshCookie)
        .expect(401);

      expect(response.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('Sign-out (/auth/logout)', () => {
    it('clears both cookies and is a no-op with no cookies present', async () => {
      const email = `logout1-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      const loginResponse = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);
      const cookies = extractAuthCookies(
        loginResponse.headers['set-cookie'] as unknown as string[],
      );

      const logoutResponse = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', cookies)
        .expect(200);

      expect(logoutResponse.body).toEqual({ message: 'Signed out.' });
      const clearedCookies = logoutResponse.headers[
        'set-cookie'
      ] as unknown as string[];
      expect(
        clearedCookies.some(
          (c) => c.startsWith('access_token=') && c.includes('Max-Age=0'),
        ),
      ).toBe(true);
      expect(
        clearedCookies.some(
          (c) => c.startsWith('refresh_token=') && c.includes('Max-Age=0'),
        ),
      ).toBe(true);

      await request(app.getHttpServer()).post('/auth/logout').expect(200);
    });

    it('leaves an emptied cookie jar unable to reach a protected resource', async () => {
      const email = `logout2-${Date.now()}@example.com`;
      const password = 'CorrectHorse123!';
      await registerActiveUser(email, password);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password })
        .expect(200);

      await request(app.getHttpServer()).post('/auth/logout').expect(200);

      await request(app.getHttpServer()).get('/rbac/roles').expect(401);
    });
  });
});
