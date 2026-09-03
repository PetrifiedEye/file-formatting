import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { attachRbacTestAuth } from './support/rbac-test-auth.module';

describe('RBAC Permissions CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;

  let accessConfigService: AccessConfigService;

  let adminUserId: string;
  let nonAdminUserId: string;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    attachRbacTestAuth(app, moduleFixture);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    permissionRepository = moduleFixture.get(getRepositoryToken(Permission));
    grantRepository = moduleFixture.get(getRepositoryToken(Grant));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    accessConfigService = moduleFixture.get(AccessConfigService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const adminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-perms-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: 'not-a-real-hash',
      }),
    );
    adminUserId = adminUser.id;

    const nonAdminUser = await userRepository.save(
      userRepository.create({
        email: `rbac-perms-nonadmin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: 'not-a-real-hash',
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
  });

  it('creates, updates a permission and rejects duplicate names', async () => {
    const name = `docs-${Date.now()}`;

    const createResponse = await request(app.getHttpServer())
      .post('/rbac/permissions')
      .set('x-test-user-id', adminUserId)
      .send({ name, actions: ['read', 'write'] })
      .expect(201);

    expect(createResponse.body.actions).toEqual(['read', 'write']);

    await request(app.getHttpServer())
      .post('/rbac/permissions')
      .set('x-test-user-id', adminUserId)
      .send({ name, actions: ['read'] })
      .expect(409);

    const updateResponse = await request(app.getHttpServer())
      .patch(`/rbac/permissions/${createResponse.body.id}`)
      .set('x-test-user-id', adminUserId)
      .send({ actions: ['read'] })
      .expect(200);
    expect(updateResponse.body.actions).toEqual(['read']);
  });

  it('rejects creating a permission with empty actions (422)', async () => {
    await request(app.getHttpServer())
      .post('/rbac/permissions')
      .set('x-test-user-id', adminUserId)
      .send({ name: `empty-${Date.now()}`, actions: [] })
      .expect(422);
  });

  it('blocks deleting a permission referenced by a grant, then allows after removing it', async () => {
    const role = await roleRepository.save(
      roleRepository.create({ name: `role-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: `blocked-${Date.now()}`,
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
      .delete(`/rbac/permissions/${permission.id}`)
      .set('x-test-user-id', adminUserId)
      .expect(409);

    await request(app.getHttpServer())
      .delete(`/rbac/grants/${grant.id}`)
      .set('x-test-user-id', adminUserId)
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/rbac/permissions/${permission.id}`)
      .set('x-test-user-id', adminUserId)
      .expect(204);
  });

  it('denies permission management for a non-admin with 403', async () => {
    await request(app.getHttpServer())
      .post('/rbac/permissions')
      .set('x-test-user-id', nonAdminUserId)
      .send({ name: `nope-${Date.now()}`, actions: ['read'] })
      .expect(403);
  });
});
