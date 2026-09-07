import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { createHash } from 'crypto';
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
import { IsNull, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import {
  RegistrationAuditEvent,
  RegistrationAuditEventType,
  RegistrationAuditOutcome,
} from '../src/modules/auth/entities/registration-audit-event.entity';
import { SystemSettings } from '../src/modules/settings/entities/system-settings.entity';
import { ConfirmationChallenge } from '../src/modules/auth/entities/confirmation-challenge.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const ADMIN_PASSWORD = 'CorrectHorse123!';

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('access_token='),
  );
  if (!cookie) {
    throw new Error('No access_token cookie found in response');
  }
  return cookie.split(';')[0];
}

describe('Auth Registration (e2e)', () => {
  let app: INestApplication<App>;
  let usersRepository: Repository<User>;
  let auditRepository: Repository<RegistrationAuditEvent>;
  let settingsRepository: Repository<SystemSettings>;
  let challengeRepository: Repository<ConfirmationChallenge>;
  let roleRepository: Repository<Role>;
  let userRoleRepository: Repository<UserRole>;
  let throttlerStorage: ThrottlerStorageService;
  let adminCookie: string;

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
    await app.getHttpAdapter().getInstance().ready();

    usersRepository = moduleFixture.get(getRepositoryToken(User));
    auditRepository = moduleFixture.get(
      getRepositoryToken(RegistrationAuditEvent),
    );
    settingsRepository = moduleFixture.get(getRepositoryToken(SystemSettings));
    challengeRepository = moduleFixture.get(
      getRepositoryToken(ConfirmationChallenge),
    );
    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    throttlerStorage = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  function clearThrottler() {
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
  }

  beforeEach(async () => {
    clearThrottler();

    await challengeRepository.createQueryBuilder().delete().execute();
    await auditRepository.createQueryBuilder().delete().execute();
    // user_roles rows cascade-delete with their user (ON DELETE CASCADE)
    await usersRepository.createQueryBuilder().delete().execute();

    await settingsRepository.update(1, {
      registrationConfirmationEnabled: false,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
    });

    const adminUser = await usersRepository.save(
      usersRepository.create({
        email: `registration-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    // Other e2e suites freely delete/recreate the `roles` table, so the
    // migration-seeded 'admin' row isn't guaranteed to still exist here —
    // upsert it rather than assuming it survived.
    let adminRole = await roleRepository.findOne({ where: { name: 'admin' } });
    if (!adminRole) {
      adminRole = await roleRepository.save(
        roleRepository.create({
          name: 'admin',
          description: 'Bootstrap administrator role',
        }),
      );
    }
    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
    );

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminUser.email, password: ADMIN_PASSWORD })
      .expect(200);
    adminCookie = extractSessionCookie(
      adminLogin.headers['set-cookie'] as unknown as string[],
    );
  });

  describe('Scenario 1 — Register without confirmation', () => {
    it('creates an active user and handles duplicate anti-enumeration', async () => {
      const email = `scenario1-${Date.now()}@example.com`;

      const registerResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      expect(registerResponse.body.confirmationRequired).toBe(false);

      const user = await usersRepository.findOne({ where: { email } });
      expect(user?.status).toBe(UserStatus.ACTIVE);

      const duplicateResponse = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'otherpass2' })
        .expect(201);

      expect(duplicateResponse.body.message).toContain('eligible');

      const users = await usersRepository.find({ where: { email } });
      expect(users).toHaveLength(1);

      const audit = await auditRepository.findOne({
        where: {
          normalizedEmail: email,
          eventType: RegistrationAuditEventType.REGISTRATION_ATTEMPT,
          outcome: RegistrationAuditOutcome.FAILURE,
        },
      });
      expect(audit?.failureReason).toBe('duplicate_email');
    });
  });

  describe('Scenario 2 — Register with confirmation', () => {
    it('creates pending user when confirmation is enabled', async () => {
      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .send({ registrationConfirmationEnabled: true })
        .expect(200);

      const email = `scenario2-${Date.now()}@example.com`;

      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      expect(response.body.confirmationRequired).toBe(true);

      const user = await usersRepository.findOne({ where: { email } });
      expect(user?.status).toBe(UserStatus.PENDING_CONFIRMATION);

      const challenge = await challengeRepository.findOne({
        where: { userId: user!.id },
      });
      expect(challenge).toBeDefined();
    });
  });

  describe('Scenario 3 — Confirm with OTP', () => {
    it('activates account with valid OTP', async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: true,
      });

      const email = `scenario3-${Date.now()}@example.com`;

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      const user = await usersRepository.findOneOrFail({ where: { email } });
      const challenge = await challengeRepository.findOneOrFail({
        where: { userId: user.id },
      });

      // Brute-force OTP lookup for e2e (only feasible in test with 6 digits)
      let otp: string | null = null;
      for (let i = 100000; i < 1000000 && !otp; i++) {
        const code = i.toString();
        const hash = createHash('sha256').update(code).digest('hex');
        if (hash === challenge.otpHash) {
          otp = code;
        }
      }

      expect(otp).not.toBeNull();

      const confirmResponse = await request(app.getHttpServer())
        .post('/auth/register/confirm/code')
        .send({ email, code: otp })
        .expect(200);

      expect(confirmResponse.body.accountReady).toBe(true);

      const updated = await usersRepository.findOneOrFail({ where: { email } });
      expect(updated.status).toBe(UserStatus.ACTIVE);
    });
  });

  describe('Scenario 4 — Confirm with magic link', () => {
    it('activates account via link token', async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: true,
      });

      const email = `scenario4-${Date.now()}@example.com`;

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      const user = await usersRepository.findOneOrFail({ where: { email } });

      // Simulate token by regenerating — in real e2e we'd parse Mailpit.
      // Instead, create a known token/challenge pair directly.
      const { randomBytes, createHash } = await import('crypto');
      const linkToken = randomBytes(32).toString('base64url');
      const linkTokenHash = createHash('sha256')
        .update(linkToken)
        .digest('hex');

      await challengeRepository.update({ userId: user.id }, { linkTokenHash });

      await request(app.getHttpServer())
        .get(`/auth/register/confirm/link?token=${linkToken}`)
        .expect(200);

      const updated = await usersRepository.findOneOrFail({ where: { email } });
      expect(updated.status).toBe(UserStatus.ACTIVE);

      await request(app.getHttpServer())
        .get(`/auth/register/confirm/link?token=${linkToken}`)
        .expect(200);
    });
  });

  describe('Scenario 5 — Resend confirmation', () => {
    it('rejects resend within 60 seconds', async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: true,
      });

      const email = `scenario5-${Date.now()}@example.com`;

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/auth/register/resend')
        .send({ email })
        .expect(429);
    });
  });

  describe('Scenario 6 — Admin policy independence', () => {
    it('recovery flag does not affect registration', async () => {
      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .send({ passwordRecoveryConfirmationEnabled: true })
        .expect(200);

      const email = `scenario6-${Date.now()}@example.com`;

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: 'validpass1' })
        .expect(201);

      const user = await usersRepository.findOne({ where: { email } });
      expect(user?.status).toBe(UserStatus.ACTIVE);
    });
  });

  describe('Scenario 7 — Rate limiting', () => {
    it('returns 429 after 5 confirmation emails in 10 minutes', async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: true,
      });

      const email = `scenario7-${Date.now()}@example.com`;

      for (let i = 0; i < 5; i++) {
        if (i === 0) {
          await request(app.getHttpServer())
            .post('/auth/register')
            .send({ email, password: 'validpass1' })
            .expect(201);
        } else {
          // Advance last_sent_at to bypass 60s resend gate
          const user = await usersRepository.findOneOrFail({
            where: { email },
          });
          const challenge = await challengeRepository.findOneOrFail({
            where: {
              userId: user.id,
              invalidatedAt: IsNull(),
              consumedAt: IsNull(),
            },
          });
          const past = new Date(Date.now() - 120_000);
          await challengeRepository.update(challenge.id, { lastSentAt: past });

          throttlerStorage.storage.clear();

          await request(app.getHttpServer())
            .post('/auth/register/resend')
            .send({ email })
            .expect(200);
        }
      }

      const user = await usersRepository.findOneOrFail({ where: { email } });
      const challenge = await challengeRepository.findOneOrFail({
        where: {
          userId: user.id,
          invalidatedAt: IsNull(),
          consumedAt: IsNull(),
        },
      });
      await challengeRepository.update(challenge.id, {
        lastSentAt: new Date(Date.now() - 120_000),
      });

      throttlerStorage.storage.clear();

      await request(app.getHttpServer())
        .post('/auth/register/resend')
        .send({ email })
        .expect(429);
    });
  });
});
