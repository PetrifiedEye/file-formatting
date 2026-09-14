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

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { SystemSettings } from '../src/modules/settings/entities/system-settings.entity';
import {
  SettingsAuditEvent,
  SettingsAuditEventType,
  SettingsAuditOutcome,
} from '../src/modules/settings/entities/settings-audit-event.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const TEST_PASSWORD = 'CorrectHorse123!';

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('access_token='),
  );
  if (!cookie) {
    throw new Error('No access_token cookie found in response');
  }
  return cookie.split(';')[0];
}

describe('Admin Settings authorization and audit (e2e)', () => {
  let app: INestApplication<App>;
  let userRepository: Repository<User>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let settingsRepository: Repository<SystemSettings>;
  let auditRepository: Repository<SettingsAuditEvent>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;

  let adminUserId: string;
  let adminRoleId: string;
  let settingsPermissionId: string;
  let settingsGrantId: string;
  let adminCookie: string;
  let plainCookie: string;

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

    userRepository = moduleFixture.get(getRepositoryToken(User));
    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    permissionRepository = moduleFixture.get(getRepositoryToken(Permission));
    grantRepository = moduleFixture.get(getRepositoryToken(Grant));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    settingsRepository = moduleFixture.get(getRepositoryToken(SystemSettings));
    auditRepository = moduleFixture.get(getRepositoryToken(SettingsAuditEvent));
    accessConfigService = moduleFixture.get(AccessConfigService);
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

    await auditRepository.createQueryBuilder().delete().execute();
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    await settingsRepository.update(1, {
      registrationConfirmationEnabled: false,
      passwordRecoveryConfirmationEnabled: false,
      signInConfirmationEnabled: false,
      passwordMinLength: 8,
    });

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const stamp = `${Date.now()}-${Math.random()}`;

    const adminUser = await userRepository.save(
      userRepository.create({
        email: `settings-admin-${stamp}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );
    adminUserId = adminUser.id;

    const plainUser = await userRepository.save(
      userRepository.create({
        email: `settings-plain-${stamp}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${stamp}` }),
    );
    adminRoleId = adminRole.id;

    const settingsPermission = await permissionRepository.save(
      permissionRepository.create({ name: 'settings', actions: ['manage'] }),
    );
    settingsPermissionId = settingsPermission.id;

    const grant = await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: settingsPermission.id,
        actions: ['manage'],
      }),
    );
    settingsGrantId = grant.id;

    await userRoleRepository.save(
      userRoleRepository.create({
        userId: adminUser.id,
        roleId: adminRole.id,
      }),
    );
    await accessConfigService.reload();

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminUser.email, password: TEST_PASSWORD })
      .expect(200);
    adminCookie = extractSessionCookie(
      adminLogin.headers['set-cookie'] as unknown as string[],
    );

    const plainLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: plainUser.email, password: TEST_PASSWORD })
      .expect(200);
    plainCookie = extractSessionCookie(
      plainLogin.headers['set-cookie'] as unknown as string[],
    );
  });

  describe('authorization', () => {
    it('rejects an unauthenticated caller with 401', async () => {
      await request(app.getHttpServer())
        .get('/admin/settings/confirmation-policy')
        .expect(401);
    });

    it('rejects a signed-in user without settings:manage with 403', async () => {
      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', plainCookie)
        .send({ signInConfirmationEnabled: true })
        .expect(403);
    });

    it('allows a role holding the settings:manage grant', async () => {
      await request(app.getHttpServer())
        .get('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .expect(200);
    });

    it('denies the same role once its settings grant is revoked', async () => {
      // The old guard tested the role NAME, so a revoked grant changed nothing.
      await grantRepository.delete(settingsGrantId);
      await accessConfigService.reload();

      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .send({ signInConfirmationEnabled: true })
        .expect(403);
    });

    it('keeps access when the admin role is renamed, since grants key on id', async () => {
      await roleRepository.update(adminRoleId, {
        name: `renamed-${Date.now()}`,
      });
      await accessConfigService.reload();

      await request(app.getHttpServer())
        .get('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .expect(200);
    });

    it('grants access to any role given settings:manage, not just "admin"', async () => {
      const opsRole = await roleRepository.save(
        roleRepository.create({ name: `ops-${Date.now()}` }),
      );
      await grantRepository.save(
        grantRepository.create({
          roleId: opsRole.id,
          permissionId: settingsPermissionId,
          actions: ['manage'],
        }),
      );

      const opsUser = await userRepository.save(
        userRepository.create({
          email: `settings-ops-${Date.now()}@example.com`,
          passwordHash: await hashPassword(TEST_PASSWORD),
          status: UserStatus.ACTIVE,
          confirmedAt: new Date(),
        }),
      );
      await userRoleRepository.save(
        userRoleRepository.create({ userId: opsUser.id, roleId: opsRole.id }),
      );
      await accessConfigService.reload();

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: opsUser.email, password: TEST_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .get('/admin/settings/confirmation-policy')
        .set(
          'Cookie',
          extractSessionCookie(
            login.headers['set-cookie'] as unknown as string[],
          ),
        )
        .expect(200);
    });
  });

  describe('audit trail', () => {
    it('records who changed the policy, with before and after values', async () => {
      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .send({ signInConfirmationEnabled: true, passwordMinLength: 12 })
        .expect(200);

      const events = await auditRepository.find();

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe(
        SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
      );
      expect(events[0].outcome).toBe(SettingsAuditOutcome.SUCCESS);
      expect(events[0].actorUserId).toBe(adminUserId);
      expect(events[0].changes).toEqual({
        signInConfirmationEnabled: { from: false, to: true },
        passwordMinLength: { from: 8, to: 12 },
      });
    });

    it('writes no audit row for a read', async () => {
      await request(app.getHttpServer())
        .get('/admin/settings/confirmation-policy')
        .set('Cookie', adminCookie)
        .expect(200);

      expect(await auditRepository.count()).toBe(0);
    });

    it('writes no audit row for a request the guard rejected', async () => {
      await request(app.getHttpServer())
        .patch('/admin/settings/confirmation-policy')
        .set('Cookie', plainCookie)
        .send({ signInConfirmationEnabled: true })
        .expect(403);

      expect(await auditRepository.count()).toBe(0);
    });
  });
});
