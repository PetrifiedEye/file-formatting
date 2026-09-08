import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { resolve } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { EmailChangeChallenge } from '../src/modules/users/entities/email-change-challenge.entity';
import { ProfileAuditEvent } from '../src/modules/users/entities/profile-audit-event.entity';
import { UserProfileAuditEvent } from '../src/modules/users/entities/user-profile-audit-event.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashSecret } from '../src/modules/auth/utils/confirmation-token';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const TEST_PASSWORD = 'CorrectHorse123!';

const JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('access_token='),
  );
  if (!cookie) {
    throw new Error('No access_token cookie found in response');
  }
  return cookie.split(';')[0];
}

function bruteForceOtp(otpHash: string): string {
  for (let i = 100000; i < 1000000; i++) {
    const code = i.toString();
    if (hashSecret(code) === otpHash) {
      return code;
    }
  }
  throw new Error('OTP not found');
}

describe('Users Profile Update (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let profileAuditRepository: Repository<ProfileAuditEvent>;
  let legacyAuditRepository: Repository<UserProfileAuditEvent>;
  let challengeRepository: Repository<EmailChangeChallenge>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let configService: ConfigService;

  let selfUser: User;
  let otherUser: User;
  let adminUser: User;
  let selfCookie: string;
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

    configService = moduleFixture.get(ConfigService);
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyCookie, {
        secret: configService.get('COOKIE_SECRET'),
      });

    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyMultipart, {
        limits: {
          fileSize: Number(configService.get('PHOTO_MAX_SIZE_BYTES')),
          files: 1,
        },
      });

    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyStatic, {
        root: resolve(configService.get('ASSETS_DIR')),
        prefix: '/assets/',
      });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    permissionRepository = moduleFixture.get(getRepositoryToken(Permission));
    grantRepository = moduleFixture.get(getRepositoryToken(Grant));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    profileAuditRepository = moduleFixture.get(
      getRepositoryToken(ProfileAuditEvent),
    );
    legacyAuditRepository = moduleFixture.get(
      getRepositoryToken(UserProfileAuditEvent),
    );
    challengeRepository = moduleFixture.get(
      getRepositoryToken(EmailChangeChallenge),
    );
    accessConfigService = moduleFixture.get(AccessConfigService);
    throttlerStorage = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;
  });

  afterAll(async () => {
    await app.close();
    await rm(resolve(configService.get('ASSETS_DIR'), 'photos'), {
      recursive: true,
      force: true,
    });
  });

  function clearThrottler() {
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
  }

  beforeEach(async () => {
    clearThrottler();

    await challengeRepository.createQueryBuilder().delete().execute();
    await profileAuditRepository.createQueryBuilder().delete().execute();
    await legacyAuditRepository.createQueryBuilder().delete().execute();
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const passwordHash = await hashPassword(TEST_PASSWORD);

    selfUser = await userRepository.save(
      userRepository.create({
        email: `pu-self-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    otherUser = await userRepository.save(
      userRepository.create({
        email: `pu-other-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    adminUser = await userRepository.save(
      userRepository.create({
        email: `pu-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const usersPermission = await permissionRepository.save(
      permissionRepository.create({
        name: 'users',
        actions: ['read', 'update', 'update-email'],
      }),
    );
    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${Date.now()}-${Math.random()}` }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: usersPermission.id,
        actions: ['update', 'update-email'],
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
    );
    await accessConfigService.reload();

    const selfLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: selfUser.email, password: TEST_PASSWORD })
      .expect(200);
    selfCookie = extractSessionCookie(
      selfLogin.headers['set-cookie'] as unknown as string[],
    );

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminUser.email, password: TEST_PASSWORD })
      .expect(200);
    adminCookie = extractSessionCookie(
      adminLogin.headers['set-cookie'] as unknown as string[],
    );

    clearThrottler();
    await challengeRepository.createQueryBuilder().delete().execute();
    await profileAuditRepository.createQueryBuilder().delete().execute();
  });

  describe('Scenario 1 & 5 — self photo update, IDOR/RBAC (US1)', () => {
    it('lets self upload a new photo', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(200);

      expect(response.body.photo).toMatch(/\/assets\/photos\/.+\.jpg$/);

      const events = await profileAuditRepository.find();
      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('success');
      expect(events[0].fields).toEqual(['photo']);
    });

    it('rejects an email field in the general update request with no field changed', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .field('email', 'new@example.com')
        .expect(400);

      const unchanged = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(unchanged?.email).toBe(selfUser.email);
    });

    it('rejects a non-admin updating another user (IDOR)', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${otherUser.id}`)
        .set('Cookie', selfCookie)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(403);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${selfUser.id}`)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(401);
    });

    it('returns 404 for a nonexistent userId targeted by an admin', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${randomUUID()}`)
        .set('Cookie', adminCookie)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(404);
    });
  });

  describe('Scenario 3 — self email-change confirmation flow (US2)', () => {
    it('initiates, confirms, and updates the email', async () => {
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'new-self@example.com' })
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      expect(challenge).not.toBeNull();
      const otp = bruteForceOtp(challenge!.otpHash);

      clearThrottler();
      const confirmResponse = await request(app.getHttpServer())
        .post('/users/me/email-change/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(200);

      expect(confirmResponse.body.email).toBe('new-self@example.com');

      const updated = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(updated?.email).toBe('new-self@example.com');
    });

    it('rejects a resend before the cooldown elapses', async () => {
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'resend-test@example.com' })
        .expect(202);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change/resend')
        .set('Cookie', selfCookie)
        .expect(429);
    });

    it('exhausts attempts after 5 wrong codes and rejects the correct one after', async () => {
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'wrong-code-test@example.com' })
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge!.otpHash);

      for (let i = 0; i < 5; i++) {
        clearThrottler();
        await request(app.getHttpServer())
          .post('/users/me/email-change/confirm')
          .set('Cookie', selfCookie)
          .send({ code: 'wrong-code' })
          .expect(400);
      }

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(400);
    });

    it('rejects an expired challenge', async () => {
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'expired-test@example.com' })
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge!.otpHash);
      challenge!.expiresAt = new Date(Date.now() - 1000);
      await challengeRepository.save(challenge!);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(400);
    });

    it('invalidates the first challenge when a second initiate is made', async () => {
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'first@example.com' })
        .expect(202);
      const firstChallenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const firstOtp = bruteForceOtp(firstChallenge!.otpHash);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: 'second@example.com' })
        .expect(202);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change/confirm')
        .set('Cookie', selfCookie)
        .send({ code: firstOtp })
        .expect(400);

      const unchanged = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(unchanged?.email).toBe(selfUser.email);
    });
  });

  describe('Scenario 4 — admin direct email update (US3)', () => {
    it('lets an admin update another user email immediately, no OTP', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/users/${otherUser.id}/email`)
        .set('Cookie', adminCookie)
        .send({ email: 'admin-set@example.com' })
        .expect(200);

      expect(response.body.email).toBe('admin-set@example.com');

      const updated = await userRepository.findOne({
        where: { id: otherUser.id },
      });
      expect(updated?.email).toBe('admin-set@example.com');
    });

    it('forbids an admin from targeting their own account', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${adminUser.id}/email`)
        .set('Cookie', adminCookie)
        .send({ email: 'self-set@example.com' })
        .expect(403);
    });

    it('forbids a non-admin caller', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${otherUser.id}/email`)
        .set('Cookie', selfCookie)
        .send({ email: 'nope@example.com' })
        .expect(403);
    });

    it('returns 404 for a nonexistent target', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${randomUUID()}/email`)
        .set('Cookie', adminCookie)
        .send({ email: 'nope@example.com' })
        .expect(404);
    });
  });
});
