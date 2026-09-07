import {
  Controller,
  Get,
  INestApplication,
  Module,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
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
import { RequirePermission } from '../src/modules/rbac/decorators/require-permission.decorator';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { PermissionGuard } from '../src/modules/rbac/guards/permission.guard';
import { RbacModule } from '../src/modules/rbac/rbac.module';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';
import { attachRbacTestAuth } from './support/rbac-test-auth.module';

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

@Controller('test-rbac-flip')
class FlipController {
  @RequirePermission('docs', 'read')
  @UseGuards(PermissionGuard)
  @Get('protected')
  protectedRoute() {
    return { ok: true };
  }
}

@Module({
  imports: [RbacModule],
  controllers: [FlipController],
})
class FlipControllerModule {}

describe('RBAC Grants CRUD (e2e)', () => {
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
      imports: [AppModule, FlipControllerModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    attachRbacTestAuth(app, moduleFixture);

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
        email: `rbac-grants-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const nonAdminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-grants-nonadmin-${Date.now()}-${Math.random()}@example.com`,
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

  it('creates a grant, rejects duplicate role+permission pairs, and out-of-range actions', async () => {
    const role = await roleRepository.save(
      roleRepository.create({ name: `role-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: `docs-${Date.now()}`,
        actions: ['read', 'write'],
      }),
    );

    const createResponse = await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({ roleId: role.id, permissionId: permission.id, actions: ['read'] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({ roleId: role.id, permissionId: permission.id })
      .expect(409);

    await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({
        roleId: role.id,
        permissionId: permission.id,
        actions: ['delete'],
      })
      .expect(422); // actions-subset check runs before the duplicate-pair check

    const otherRole = await roleRepository.save(
      roleRepository.create({ name: `role2-${Date.now()}` }),
    );
    await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({
        roleId: otherRole.id,
        permissionId: permission.id,
        actions: ['delete'],
      })
      .expect(422);

    await request(app.getHttpServer())
      .delete(`/rbac/grants/${createResponse.body.id}`)
      .set('Cookie', adminCookie)
      .expect(204);
  });

  it('flips an access-check outcome immediately when a grant is created and deleted', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: `rbac-flip-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: 'not-a-real-hash',
      }),
    );
    const role = await roleRepository.save(
      roleRepository.create({ name: `flip-role-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({ name: 'docs', actions: ['read'] }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: user.id, roleId: role.id }),
    );

    await request(app.getHttpServer())
      .get('/test-rbac-flip/protected')
      .set('x-test-user-id', user.id)
      .expect(403);

    const grantResponse = await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', adminCookie)
      .send({ roleId: role.id, permissionId: permission.id })
      .expect(201);

    await request(app.getHttpServer())
      .get('/test-rbac-flip/protected')
      .set('x-test-user-id', user.id)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/rbac/grants/${grantResponse.body.id}`)
      .set('Cookie', adminCookie)
      .expect(204);

    await request(app.getHttpServer())
      .get('/test-rbac-flip/protected')
      .set('x-test-user-id', user.id)
      .expect(403);
  });

  it('denies grant management for a non-admin with 403', async () => {
    const role = await roleRepository.save(
      roleRepository.create({ name: `role-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: `docs-${Date.now()}`,
        actions: ['read'],
      }),
    );

    await request(app.getHttpServer())
      .post('/rbac/grants')
      .set('Cookie', nonAdminCookie)
      .send({ roleId: role.id, permissionId: permission.id })
      .expect(403);
  });
});
