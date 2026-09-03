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
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { RequirePermission } from '../src/modules/rbac/decorators/require-permission.decorator';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { PermissionGuard } from '../src/modules/rbac/guards/permission.guard';
import { RbacModule } from '../src/modules/rbac/rbac.module';
import { User } from '../src/modules/users/entities/user.entity';
import { attachRbacTestAuth } from './support/rbac-test-auth.module';

@Controller('test-rbac')
class TestRbacController {
  @RequirePermission('docs', 'read')
  @UseGuards(PermissionGuard)
  @Get('protected')
  protectedRoute() {
    return { ok: true };
  }
}

@Module({
  imports: [RbacModule],
  controllers: [TestRbacController],
})
class TestRbacControllerModule {}

describe('RBAC Access Check (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let accessConfigService: AccessConfigService;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, TestRbacControllerModule],
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
  });

  const seedUser = async () =>
    userRepository.save(
      userRepository.create({
        email: `rbac-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: 'not-a-real-hash',
      }),
    );

  it('returns 401 for an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/test-rbac/protected').expect(401);
  });

  it('returns 403 for an authenticated user without the grant', async () => {
    const user = await seedUser();

    await request(app.getHttpServer())
      .get('/test-rbac/protected')
      .set('x-test-user-id', user.id)
      .expect(403);
  });

  it('returns 200 for a user whose role grants the permission+action', async () => {
    const user = await seedUser();
    const role = await roleRepository.save(
      roleRepository.create({ name: `editor-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: 'docs',
        actions: ['read', 'write'],
      }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: role.id,
        permissionId: permission.id,
        actions: ['read'],
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: user.id, roleId: role.id }),
    );
    await accessConfigService.reload();

    await request(app.getHttpServer())
      .get('/test-rbac/protected')
      .set('x-test-user-id', user.id)
      .expect(200);
  });

  it('returns 403 when the grant only covers a different action', async () => {
    const user = await seedUser();
    const role = await roleRepository.save(
      roleRepository.create({ name: `viewer-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({
        name: 'docs',
        actions: ['read', 'write'],
      }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: role.id,
        permissionId: permission.id,
        actions: ['write'],
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({ userId: user.id, roleId: role.id }),
    );
    await accessConfigService.reload();

    await request(app.getHttpServer())
      .get('/test-rbac/protected')
      .set('x-test-user-id', user.id)
      .expect(403);
  });

  it('returns 200 when only one of the user two roles grants access (FR-022)', async () => {
    const user = await seedUser();
    const grantingRole = await roleRepository.save(
      roleRepository.create({ name: `granting-${Date.now()}` }),
    );
    const otherRole = await roleRepository.save(
      roleRepository.create({ name: `other-${Date.now()}` }),
    );
    const permission = await permissionRepository.save(
      permissionRepository.create({ name: 'docs', actions: ['read'] }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: grantingRole.id,
        permissionId: permission.id,
        actions: null,
      }),
    );
    await userRoleRepository.save([
      userRoleRepository.create({ userId: user.id, roleId: otherRole.id }),
      userRoleRepository.create({ userId: user.id, roleId: grantingRole.id }),
    ]);
    await accessConfigService.reload();

    await request(app.getHttpServer())
      .get('/test-rbac/protected')
      .set('x-test-user-id', user.id)
      .expect(200);
  });
});
