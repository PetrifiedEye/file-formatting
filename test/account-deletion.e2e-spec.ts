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
import { existsSync } from 'fs';
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
import { LoginAuditEvent } from '../src/modules/auth/entities/login-audit-event.entity';
import { hashSecret } from '../src/modules/auth/utils/confirmation-token';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { AccountDeletionAuditEvent } from '../src/modules/users/entities/account-deletion-audit-event.entity';
import { AccountDeletionChallenge } from '../src/modules/users/entities/account-deletion-challenge.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';

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

describe('Account Deletion (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let challengeRepository: Repository<AccountDeletionChallenge>;
  let auditRepository: Repository<AccountDeletionAuditEvent>;
  let loginAuditRepository: Repository<LoginAuditEvent>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let configService: ConfigService;

  let selfUser: User;
  let otherUser: User;
  let adminUser: User;
  let nonAdminUser: User;
  let selfCookie: string;
  let adminCookie: string;
  let nonAdminCookie: string;

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
    challengeRepository = moduleFixture.get(
      getRepositoryToken(AccountDeletionChallenge),
    );
    auditRepository = moduleFixture.get(
      getRepositoryToken(AccountDeletionAuditEvent),
    );
    loginAuditRepository = moduleFixture.get(
      getRepositoryToken(LoginAuditEvent),
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

    await auditRepository.createQueryBuilder().delete().execute();
    await challengeRepository.createQueryBuilder().delete().execute();
    await loginAuditRepository.createQueryBuilder().delete().execute();
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const passwordHash = await hashPassword(TEST_PASSWORD);

    selfUser = await userRepository.save(
      userRepository.create({
        email: `del-self-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    otherUser = await userRepository.save(
      userRepository.create({
        email: `del-other-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    adminUser = await userRepository.save(
      userRepository.create({
        email: `del-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    nonAdminUser = await userRepository.save(
      userRepository.create({
        email: `del-nonadmin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const usersPermission = await permissionRepository.save(
      permissionRepository.create({
        name: 'users',
        actions: ['read', 'update', 'update-email', 'delete'],
      }),
    );
    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${Date.now()}-${Math.random()}` }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: usersPermission.id,
        actions: ['update', 'update-email', 'delete'],
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
    );
    await accessConfigService.reload();

    const login = async (user: User) => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return extractSessionCookie(
        response.headers['set-cookie'] as unknown as string[],
      );
    };

    selfCookie = await login(selfUser);
    adminCookie = await login(adminUser);
    nonAdminCookie = await login(nonAdminUser);

    clearThrottler();
    await auditRepository.createQueryBuilder().delete().execute();
    await challengeRepository.createQueryBuilder().delete().execute();
  });

  describe('Scenario 1 — self-deletion happy path (US1, P1)', () => {
    it('initiates, confirms, and removes the account, photo, and PII', async () => {
      await request(app.getHttpServer())
        .patch(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(200);

      const withPhoto = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      const photoRelativePath = withPhoto!.photoUrl!.replace(
        `${configService.get('ASSETS_BASE_URL')}/assets/`,
        '',
      );
      const photoAbsolutePath = resolve(
        configService.get('ASSETS_DIR'),
        photoRelativePath,
      );
      expect(existsSync(photoAbsolutePath)).toBe(true);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      expect(challenge).not.toBeNull();
      const otp = bruteForceOtp(challenge!.otpHash);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(200);

      const deletedUser = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(deletedUser).toBeNull();

      const remainingChallenges = await challengeRepository.find({
        where: { userId: selfUser.id },
      });
      expect(remainingChallenges).toHaveLength(0);

      expect(existsSync(photoAbsolutePath)).toBe(false);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: selfUser.email, password: TEST_PASSWORD })
        .expect(401);

      const events = await auditRepository.find({
        where: { targetId: selfUser.id },
      });
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.action)).toEqual([
        'self_delete_initiated',
        'self_delete_confirmed',
      ]);
      expect(events.map((event) => event.outcome)).toEqual([
        'success',
        'success',
      ]);
      expect(JSON.stringify(events)).not.toContain(selfUser.email);
    });
  });

  describe('Scenario 2 — self-deletion rejected without confirmation (US1, AS-3)', () => {
    it('leaves the account untouched when confirmation is never completed', async () => {
      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: selfUser.email, password: TEST_PASSWORD })
        .expect(200);
    });
  });

  describe('Scenario 3 — self-deletion confirmation expires (US1, AS-4)', () => {
    it('rejects an expired confirmation and leaves the account active', async () => {
      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge!.otpHash);
      challenge!.expiresAt = new Date(Date.now() - 1000);
      await challengeRepository.save(challenge!);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(400);

      const stillThere = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(stillThere).not.toBeNull();
    });
  });

  describe('Scenario 4 — admin deletes another user directly (US2, P2)', () => {
    it('deletes the target immediately, no confirmation, and audits the admin as actor', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200)
        .expect({ message: 'deleted' });

      const deletedUser = await userRepository.findOne({
        where: { id: otherUser.id },
      });
      expect(deletedUser).toBeNull();

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: otherUser.email, password: TEST_PASSWORD })
        .expect(401);

      const events = await auditRepository.find({
        where: { targetId: otherUser.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('admin_delete');
      expect(events[0].outcome).toBe('success');
      expect(events[0].actorId).toBe(adminUser.id);
    });
  });

  describe('Scenario 5 — admin re-deletes an already-deleted account (US2, AS-2)', () => {
    it('is idempotent and reports already removed with no error', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200)
        .expect({ message: 'already removed' });
    });
  });

  describe('Scenario 6 — non-admin cannot delete another user (US3, P2)', () => {
    it('rejects with 403 and leaves the target active', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', nonAdminCookie)
        .expect(403);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: otherUser.email, password: TEST_PASSWORD })
        .expect(200);
    });
  });

  describe('Scenario 7 — admin cannot bypass self-confirmation via the admin route', () => {
    it('rejects an admin targeting their own id with 403', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${adminUser.id}`)
        .set('Cookie', adminCookie)
        .expect(403);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: adminUser.email, password: TEST_PASSWORD })
        .expect(200);
    });
  });

  describe('Scenario 8 — deletion targeting a nonexistent user', () => {
    it('returns an idempotent already-removed result for an id that never existed', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${randomUUID()}`)
        .set('Cookie', adminCookie)
        .expect(200)
        .expect({ message: 'already removed' });
    });
  });

  describe('Scenario 9 — concurrent deletion attempts', () => {
    it('rejects a second admin-delete once the account is already mid-deletion', async () => {
      await userRepository.update(
        { id: otherUser.id },
        { deletionStartedAt: new Date() },
      );

      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(409);

      const stillThere = await userRepository.findOne({
        where: { id: otherUser.id },
      });
      expect(stillThere).not.toBeNull();
    });
  });

  describe('Scenario 10 — rate limiting', () => {
    it('rejects a resend before the cooldown elapses', async () => {
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/resend')
        .set('Cookie', selfCookie)
        .expect(429);
    });
  });

  describe('Scenario 11 — wrong confirmation code attempts exhausted', () => {
    it('rejects after 5 wrong codes and rejects the correct one afterward', async () => {
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge!.otpHash);

      for (let i = 0; i < 5; i++) {
        clearThrottler();
        await request(app.getHttpServer())
          .post('/users/me/delete/confirm')
          .set('Cookie', selfCookie)
          .send({ code: 'wrong-code' })
          .expect(400);
      }

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(400);

      const stillThere = await userRepository.findOne({
        where: { id: selfUser.id },
      });
      expect(stillThere).not.toBeNull();
    });
  });
});
