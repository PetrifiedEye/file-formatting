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
import { SystemSettings } from '../src/modules/settings/entities/system-settings.entity';
import { AuthSession } from '../src/modules/auth/entities/auth-session.entity';
import { PasswordResetChallenge } from '../src/modules/auth/entities/password-reset-challenge.entity';
import { EmailChangeChallenge } from '../src/modules/users/entities/email-change-challenge.entity';
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
  let sessionRepository: Repository<AuthSession>;
  let settingsRepository: Repository<SystemSettings>;
  let passwordResetRepository: Repository<PasswordResetChallenge>;
  let emailChangeRepository: Repository<EmailChangeChallenge>;
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
    sessionRepository = moduleFixture.get(getRepositoryToken(AuthSession));
    settingsRepository = moduleFixture.get(getRepositoryToken(SystemSettings));
    passwordResetRepository = moduleFixture.get(
      getRepositoryToken(PasswordResetChallenge),
    );
    emailChangeRepository = moduleFixture.get(
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
    // This case clears the throttler first on purpose: it isolates the
    // service-level resend cooldown from the @Throttle decorator. The case
    // below covers the decorator; neither stands in for the other.
    it('rejects a resend before the service cooldown elapses, with the throttler out of the way', async () => {
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

    it('enforces the @Throttle limit on DELETE /users/:userId (5 per minute)', async () => {
      // Deleting ids that never existed is idempotent, so every call inside
      // the limit succeeds and only the throttler can reject the last one.
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .delete(`/users/${randomUUID()}`)
          .set('Cookie', adminCookie)
          .expect(200)
          .expect({ message: 'already removed' });
      }

      const throttled = await request(app.getHttpServer())
        .delete(`/users/${randomUUID()}`)
        .set('Cookie', adminCookie)
        .expect(429);

      expect(throttled.body.message).toMatch(/too many requests/i);

      // Clearing the throttler is the only thing that changes, proving the
      // rejection came from the decorator and not from any service-side state.
      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${randomUUID()}`)
        .set('Cookie', adminCookie)
        .expect(200);
    });

    it('keeps a per-route budget: exhausting the delete route leaves the directory route usable', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .delete(`/users/${randomUUID()}`)
          .set('Cookie', adminCookie)
          .expect(200);
      }

      await request(app.getHttpServer())
        .delete(`/users/${randomUUID()}`)
        .set('Cookie', adminCookie)
        .expect(429);

      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);
    });
  });

  describe('Scenario 14 — the freed email is re-registrable, with a clean slate', () => {
    let savedSettings: SystemSettings;

    beforeEach(async () => {
      // Register straight to active so the new account can be inspected
      // without going through a confirmation challenge. Settings are a single
      // global row, so the previous values are restored afterwards rather than
      // left for whichever suite runs next.
      savedSettings = await settingsRepository.findOneOrFail({
        where: { id: 1 },
      });
      await settingsRepository.update(1, {
        registrationConfirmationEnabled: false,
        signInConfirmationEnabled: false,
      });
    });

    afterEach(async () => {
      await settingsRepository.update(1, {
        registrationConfirmationEnabled:
          savedSettings.registrationConfirmationEnabled,
        signInConfirmationEnabled: savedSettings.signInConfirmationEnabled,
      });
    });

    it('lets the address be claimed again, carrying nothing over from the old account', async () => {
      const freedEmail = selfUser.email;
      const oldId = selfUser.id;

      // Give the old account a role and some audit history worth not
      // inheriting.
      const role = await roleRepository.save(
        roleRepository.create({
          name: `legacy-${Date.now()}-${Math.random()}`,
        }),
      );
      await userRoleRepository.save(
        userRoleRepository.create({ userId: oldId, roleId: role.id }),
      );
      expect(
        await loginAuditRepository.countBy({ userId: oldId }),
      ).toBeGreaterThan(0);

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${oldId}`)
        .set('Cookie', adminCookie)
        .expect(200);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: freedEmail, password: TEST_PASSWORD })
        .expect(201);

      const reborn = await userRepository.findOneOrFail({
        where: { email: freedEmail },
      });

      // A genuinely new row, not a resurrected one.
      expect(reborn.id).not.toBe(oldId);
      expect(reborn.photoUrl).toBeNull();
      expect(reborn.deletionStartedAt).toBeNull();

      // No roles inherited: the old membership went with the old row, and
      // nothing re-attached it by email.
      expect(await userRoleRepository.countBy({ userId: reborn.id })).toBe(0);

      // No audit linkage either — the old rows were detached by the FK's
      // SET NULL, not re-pointed at whoever takes the address next.
      expect(await loginAuditRepository.countBy({ userId: oldId })).toBe(0);
      const auditForReborn = await loginAuditRepository.countBy({
        userId: reborn.id,
      });
      expect(auditForReborn).toBe(0);

      expect(await auditRepository.countBy({ targetId: reborn.id })).toBe(0);
    });

    it('lets the re-registered account sign in with its own new password', async () => {
      const freedEmail = selfUser.email;
      const newPassword = 'DifferentHorse456!';

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${selfUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: freedEmail, password: newPassword })
        .expect(201);

      // The old credentials must not work against the new account.
      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: freedEmail, password: TEST_PASSWORD })
        .expect(401);

      clearThrottler();
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: freedEmail, password: newPassword })
        .expect(200);

      const cookie = extractSessionCookie(
        login.headers['set-cookie'] as unknown as string[],
      );
      const session = await request(app.getHttpServer())
        .get('/auth/session')
        .set('Cookie', cookie)
        .expect(200);

      expect(session.body.id).not.toBe(selfUser.id);
      expect(session.body.roles).toEqual([]);
    });
  });

  describe('Scenario 13 — every row hanging off the account goes with it', () => {
    /**
     * Gives selfUser at least one row in each table that references users:
     * a role membership, two sessions, and three kinds of challenge — plus a
     * photo on disk and audit rows that must NOT cascade.
     */
    async function buildFullFootprint(): Promise<{
      photoAbsolutePath: string;
      secondCookie: string;
    }> {
      const role = await roleRepository.save(
        roleRepository.create({
          name: `member-${Date.now()}-${Math.random()}`,
        }),
      );
      await userRoleRepository.save(
        userRoleRepository.create({ userId: selfUser.id, roleId: role.id }),
      );

      await request(app.getHttpServer())
        .patch(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .attach('photo', JPEG_BUFFER, 'avatar.jpg')
        .expect(200);

      const withPhoto = await userRepository.findOneOrFail({
        where: { id: selfUser.id },
      });
      const photoAbsolutePath = resolve(
        configService.get('ASSETS_DIR'),
        withPhoto.photoUrl!.replace(
          `${configService.get('ASSETS_BASE_URL')}/assets/`,
          '',
        ),
      );
      expect(existsSync(photoAbsolutePath)).toBe(true);

      // A second concurrent sign-in, so the cascade has to clear more than
      // just the session doing the deleting.
      clearThrottler();
      const secondLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: selfUser.email, password: TEST_PASSWORD })
        .expect(200);
      const secondCookie = extractSessionCookie(
        secondLogin.headers['set-cookie'] as unknown as string[],
      );

      // Inserted directly rather than via POST /auth/password-reset/request:
      // that endpoint is a no-op unless passwordRecoveryConfirmationEnabled is
      // set, and this suite should not depend on global settings state.
      await passwordResetRepository.save(
        passwordResetRepository.create({
          userId: selfUser.id,
          otpHash: hashSecret('123456'),
          linkTokenHash: hashSecret(`link-${Date.now()}-${Math.random()}`),
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 900000),
          attemptsRemaining: 5,
        }),
      );

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/email-change')
        .set('Cookie', selfCookie)
        .send({ newEmail: `moved-${Date.now()}-${Math.random()}@example.com` })
        .expect(202);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      // Guard the guard: if any of these were already empty, the assertions
      // after the deletion would prove nothing.
      await expect(
        userRoleRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(1);
      await expect(
        sessionRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(2);
      await expect(
        passwordResetRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(1);
      await expect(
        emailChangeRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(1);
      await expect(
        challengeRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(1);

      return { photoAbsolutePath, secondCookie };
    }

    async function expectFootprintGone(photoAbsolutePath: string) {
      await expect(userRepository.countBy({ id: selfUser.id })).resolves.toBe(
        0,
      );
      await expect(
        userRoleRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      await expect(
        sessionRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      await expect(
        passwordResetRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      await expect(
        emailChangeRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      await expect(
        challengeRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      expect(existsSync(photoAbsolutePath)).toBe(false);
    }

    it('cascades every dependent row, and the photo, on self-deletion', async () => {
      const { photoAbsolutePath, secondCookie } = await buildFullFootprint();

      const challenge = await challengeRepository.findOneOrFail({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge.otpHash);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(200);

      await expectFootprintGone(photoAbsolutePath);

      // The other browser's session is gone too, not just the one that
      // confirmed the deletion.
      clearThrottler();
      await request(app.getHttpServer())
        .get('/auth/session')
        .set('Cookie', secondCookie)
        .expect(401);
    });

    it('cascades the same rows on admin deletion', async () => {
      const { photoAbsolutePath } = await buildFullFootprint();

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${selfUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      await expectFootprintGone(photoAbsolutePath);
    });

    it('keeps the audit trail, detaching it rather than cascading it', async () => {
      await buildFullFootprint();

      const auditBefore = await loginAuditRepository.countBy({
        userId: selfUser.id,
      });
      expect(auditBefore).toBeGreaterThan(0);

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${selfUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      // login_audit_events.user_id is ON DELETE SET NULL: the history of what
      // happened survives, stripped of the reference to the removed account.
      await expect(
        loginAuditRepository.countBy({ userId: selfUser.id }),
      ).resolves.toBe(0);
      const orphaned = await loginAuditRepository.count();
      expect(orphaned).toBeGreaterThanOrEqual(auditBefore);
    });
  });

  describe('Scenario 12 — a deleted account cannot keep using its live cookies', () => {
    it('rejects the still-unexpired access cookie of a self-deleted user', async () => {
      const profileBefore = await request(app.getHttpServer())
        .get(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .expect(200);
      expect(profileBefore.body.id).toBe(selfUser.id);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', selfCookie)
        .expect(202);

      const challenge = await challengeRepository.findOne({
        where: { userId: selfUser.id },
      });
      const otp = bruteForceOtp(challenge!.otpHash);

      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete/confirm')
        .set('Cookie', selfCookie)
        .send({ code: otp })
        .expect(200);

      // Same cookie, unchanged and nowhere near its expiry. The JWT still
      // verifies; only the server-side user lookup can reject it.
      clearThrottler();
      await request(app.getHttpServer())
        .get(`/users/${selfUser.id}`)
        .set('Cookie', selfCookie)
        .expect(401);
    });

    it('rejects the live access and refresh cookies of an admin-deleted user', async () => {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: otherUser.email, password: TEST_PASSWORD })
        .expect(200);
      const setCookie = login.headers['set-cookie'] as unknown as string[];
      const access = extractCookie(setCookie, 'access_token');
      const refresh = extractCookie(setCookie, 'refresh_token');

      clearThrottler();
      await request(app.getHttpServer())
        .get(`/users/${otherUser.id}`)
        .set('Cookie', access)
        .expect(200);

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      clearThrottler();
      await request(app.getHttpServer())
        .get(`/users/${otherUser.id}`)
        .set('Cookie', access)
        .expect(401);

      // The refresh token must not mint a fresh pair either, or deletion
      // would only hold for the access token's short lifetime.
      clearThrottler();
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', refresh)
        .expect(401);
    });

    it('does not let a deleted user reach an endpoint their id no longer owns', async () => {
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: otherUser.email, password: TEST_PASSWORD })
        .expect(200);
      const access = extractCookie(
        login.headers['set-cookie'] as unknown as string[],
        'access_token',
      );

      clearThrottler();
      await request(app.getHttpServer())
        .delete(`/users/${otherUser.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      // Any authenticated route, not just the one keyed by the deleted id.
      clearThrottler();
      await request(app.getHttpServer())
        .post('/users/me/delete')
        .set('Cookie', access)
        .expect(401);

      clearThrottler();
      await request(app.getHttpServer())
        .get('/auth/session')
        .set('Cookie', access)
        .expect(401);
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
