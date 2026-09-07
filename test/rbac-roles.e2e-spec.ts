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
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const TEST_PASSWORD = 'CorrectHorse123!';

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('session='),
  );
  if (!cookie) {
    throw new Error('No session cookie found in response');
  }
  return cookie.split(';')[0];
}

describe('RBAC Roles CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;

  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;

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

    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const passwordHash = await hashPassword(TEST_PASSWORD);

    const adminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-roles-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const nonAdminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-roles-nonadmin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

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
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
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
  });

  it('creates, lists, updates a role and rejects duplicate names', async () => {
    const name = `editor-${Date.now()}`;

    const createResponse = await request(app.getHttpServer())
      .post('/rbac/roles')
      .set('Cookie', adminCookie)
      .send({ name })
      .expect(201);

    expect(createResponse.body.name).toBe(name);

    await request(app.getHttpServer())
      .post('/rbac/roles')
      .set('Cookie', adminCookie)
      .send({ name })
      .expect(409);

    const listResponse = await request(app.getHttpServer())
      .get('/rbac/roles')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(
      listResponse.body.some((r: { name: string }) => r.name === name),
    ).toBe(true);

    const updateResponse = await request(app.getHttpServer())
      .patch(`/rbac/roles/${createResponse.body.id}`)
      .set('Cookie', adminCookie)
      .send({ description: 'updated' })
      .expect(200);
    expect(updateResponse.body.description).toBe('updated');
  });

  it('blocks deleting a role referenced by a grant, then allows after removing it', async () => {
    const role = await roleRepository.save(
      roleRepository.create({ name: `blocked-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: `docs-${Date.now()}`,
        actions: ['read'],
      }),
    );
    const grant = await grantRepository.save(
      grantRepository.create({
        roleId: role.id,
        permissionId: permission.id,
        actions: null,
      }),
    );

    await request(app.getHttpServer())
      .delete(`/rbac/roles/${role.id}`)
      .set('Cookie', adminCookie)
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/rbac/grants/${grant.id}`)
      .set('Cookie', adminCookie)
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/rbac/roles/${role.id}`)
      .set('Cookie', adminCookie)
      .expect(204);
  });

  it('denies role management for a non-admin with 403', async () => {
    await request(app.getHttpServer())
      .post('/rbac/roles')
      .set('Cookie', nonAdminCookie)
      .send({ name: `nope-${Date.now()}` })
      .expect(403);
  });
});
