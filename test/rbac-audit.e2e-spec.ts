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
import {
  RbacAuditEvent,
  RbacAuditEventType,
  RbacAuditOutcome,
} from '../src/modules/rbac/entities/rbac-audit-event.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
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

describe('RBAC Audit Trail (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let auditRepository: Repository<RbacAuditEvent>;

  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;

  let adminUserId: string;
  let nonAdminUserId: string;
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

    const configService = moduleFixture.get(ConfigService);
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyCookie, {
        secret: configService.get('COOKIE_SECRET'),
      });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    permissionRepository = moduleFixture.get(getRepositoryToken(Permission));
    grantRepository = moduleFixture.get(getRepositoryToken(Grant));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    auditRepository = moduleFixture.get(getRepositoryToken(RbacAuditEvent));
    accessConfigService = moduleFixture.get(AccessConfigService);
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

    await auditRepository.createQueryBuilder().delete().execute();
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const passwordHash = await hashPassword(TEST_PASSWORD);

    const adminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-audit-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );
    adminUserId = adminUser.id;

    const nonAdminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-audit-nonadmin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );
    nonAdminUserId = nonAdminUser.id;

    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${Date.now()}-${Math.random()}` }),
    );
    const rbacPermission = await permissionRepository.save(
      permissionRepository.create({
        name: 'rbac',
        actions: ['manage'],
      }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: rbacPermission.id,
        actions: null,
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUserId, roleId: adminRole.id }),
    );
    await accessConfigService.reload();

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: adminUser.email, password: TEST_PASSWORD })
      .expect(200);
    adminCookie = extractSessionCookie(
      adminLogin.headers['set-cookie'] as unknown as string[],
    );

    const nonAdminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: nonAdminUser.email, password: TEST_PASSWORD })
      .expect(200);
    nonAdminCookie = extractSessionCookie(
      nonAdminLogin.headers['set-cookie'] as unknown as string[],
    );

    // reset the audit log after seed writes and logins above so each test starts clean
    await auditRepository.createQueryBuilder().delete().execute();
  });

  it('logs create/update/delete across roles, permissions, and grants, plus reloads', async () => {
    const roleCreate = await request(app.getHttpServer())
      .post('/rbac/roles')
      .set('Cookie', adminCookie)
      .send({ name: `audit-role-${Date.now()}` })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/rbac/roles/${roleCreate.body.id}`)
      .set('Cookie', adminCookie)
      .send({ description: 'updated' })
      .expect(200);

    const permissionCreate = await request(app.getHttpServer())
      .post('/rbac/permissions')
      .set('Cookie', adminCookie)
      .send({ name: `audit-perm-${Date.now()}`, actions: ['read'] })
      .expect(201);

    const grantCreate = await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({
        roleId: roleCreate.body.id,
        permissionId: permissionCreate.body.id,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/rbac/grants/${grantCreate.body.id}`)
      .set('Cookie', adminCookie)
      .expect(204);

    const events = await auditRepository.find({
      order: { createdAt: 'ASC' },
    });

    for (const event of events) {
      expect(event.outcome).toBe(RbacAuditOutcome.SUCCESS);

      // config_reloaded is a system-level event triggered internally by
      // AccessConfigService.reload() — it isn't tied to a specific actor or entity.
      if (event.eventType === RbacAuditEventType.CONFIG_RELOADED) {
        continue;
      }

      expect(event.actorUserId).toBe(adminUserId);
      expect(event.entityType).not.toBeNull();
      expect(event.entityId).not.toBeNull();
    }

    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        RbacAuditEventType.ROLE_CREATED,
        RbacAuditEventType.ROLE_UPDATED,
        RbacAuditEventType.PERMISSION_CREATED,
        RbacAuditEventType.GRANT_CREATED,
        RbacAuditEventType.GRANT_DELETED,
        RbacAuditEventType.CONFIG_RELOADED,
      ]),
    );
  });

  it('logs management_access_denied for a non-admin management attempt', async () => {
    await request(app.getHttpServer())
      .post('/rbac/roles')
      .set('Cookie', nonAdminCookie)
      .send({ name: `denied-${Date.now()}` })
      .expect(403);

    const deniedEvent = await auditRepository.findOne({
      where: {
        eventType: RbacAuditEventType.MANAGEMENT_ACCESS_DENIED,
        actorUserId: nonAdminUserId,
      },
    });

    expect(deniedEvent).not.toBeNull();
    expect(deniedEvent?.outcome).toBe(RbacAuditOutcome.FAILURE);
  });
});
