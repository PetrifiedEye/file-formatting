import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import fastifyCookie from '@fastify/cookie';
import { randomUUID } from 'crypto';
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
import {
  UserProfileAuditEvent,
  UserProfileAuditOutcome,
} from '../src/modules/users/entities/user-profile-audit-event.entity';
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

describe('Users Profile (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let auditRepository: Repository<UserProfileAuditEvent>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;

  let selfUser: User;
  let targetUser: User;
  let privilegedUser: User;
  let selfCookie: string;
  let privilegedCookie: string;

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
    auditRepository = moduleFixture.get(
      getRepositoryToken(UserProfileAuditEvent),
    );
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

    selfUser = await userRepository.save(
      userRepository.create({
        email: `profile-self-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
        photoUrl: 'https://cdn.example.com/self.jpg',
      }),
    );

    targetUser = await userRepository.save(
      userRepository.create({
        email: `profile-target-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
        photoUrl: 'https://cdn.example.com/target.jpg',
      }),
    );

    privilegedUser = await userRepository.save(
      userRepository.create({
        email: `profile-privileged-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const usersPermission = await permissionRepository.save(
      permissionRepository.create({ name: 'users', actions: ['read'] }),
    );
    const readerRole = await roleRepository.save(
      roleRepository.create({ name: `reader-${Date.now()}-${Math.random()}` }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: readerRole.id,
        permissionId: usersPermission.id,
        actions: ['read'],
      }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({
        userId: privilegedUser.id,
        roleId: readerRole.id,
      }),
    );
    await accessConfigService.reload();

    const selfLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: selfUser.email, password: TEST_PASSWORD })
      .expect(200);
    selfCookie = extractSessionCookie(
      selfLogin.headers['set-cookie'] as unknown as string[],
    );

    const privilegedLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: privilegedUser.email, password: TEST_PASSWORD })
      .expect(200);
    privilegedCookie = extractSessionCookie(
      privilegedLogin.headers['set-cookie'] as unknown as string[],
    );

    // reset audit rows created by the seed logins above so each test starts clean
    await auditRepository.createQueryBuilder().delete().execute();
  });

  it('returns the full self-profile regardless of roles (Story 1)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/users/${selfUser.id}`)
      .set('Cookie', selfCookie)
      .expect(200);

    expect(response.body).toEqual({
      id: selfUser.id,
      email: selfUser.email,
      photo: 'https://cdn.example.com/self.jpg',
      status: UserStatus.ACTIVE,
      createdAt: selfUser.createdAt.toISOString(),
    });
  });

  it('returns only id and photo for a privileged viewer of another user (Story 2)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/users/${targetUser.id}`)
      .set('Cookie', privilegedCookie)
      .expect(200);

    expect(response.body).toEqual({
      id: targetUser.id,
      photo: 'https://cdn.example.com/target.jpg',
    });
  });

  it('denies a non-privileged viewer for both an existing and a nonexistent target (Story 3)', async () => {
    const existingResponse = await request(app.getHttpServer())
      .get(`/users/${targetUser.id}`)
      .set('Cookie', selfCookie)
      .expect(403);
    expect(existingResponse.body.id).toBeUndefined();
    expect(existingResponse.body.email).toBeUndefined();
    expect(existingResponse.body.photo).toBeUndefined();

    clearThrottler();

    const nonexistentResponse = await request(app.getHttpServer())
      .get(`/users/${randomUUID()}`)
      .set('Cookie', selfCookie)
      .expect(403);
    expect(nonexistentResponse.body.id).toBeUndefined();
  });

  it('rejects an unauthenticated request with 401 before any lookup (Story 4)', async () => {
    await request(app.getHttpServer()).get(`/users/${selfUser.id}`).expect(401);
  });

  it('returns 404 for a privileged viewer targeting a nonexistent user (Story 4)', async () => {
    // The self-branch's "deleted mid-session" 404 is covered at the unit
    // level (users.service.spec.ts): JwtAuthGuard already rejects a deleted
    // user's own token with 401 before the controller runs, so that branch
    // is unreachable end-to-end with a real session.
    const nonexistentResponse = await request(app.getHttpServer())
      .get(`/users/${randomUUID()}`)
      .set('Cookie', privilegedCookie)
      .expect(404);
    expect(nonexistentResponse.body.message).toBe('User not found');
  });

  it('returns 404 (not a raw 400) for a malformed userId when the caller is authorized (Story 4)', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/not-a-uuid')
      .set('Cookie', privilegedCookie)
      .expect(404);

    expect(response.body.message).toBe('User not found');
  });

  it('records one audit row per outcome with no field values (Story 5)', async () => {
    await request(app.getHttpServer())
      .get(`/users/${selfUser.id}`)
      .set('Cookie', selfCookie)
      .expect(200);

    clearThrottler();

    await request(app.getHttpServer())
      .get(`/users/${targetUser.id}`)
      .set('Cookie', privilegedCookie)
      .expect(200);

    clearThrottler();

    await request(app.getHttpServer())
      .get(`/users/${targetUser.id}`)
      .set('Cookie', selfCookie)
      .expect(403);

    clearThrottler();

    const nonexistentId = randomUUID();
    await request(app.getHttpServer())
      .get(`/users/${nonexistentId}`)
      .set('Cookie', privilegedCookie)
      .expect(404);

    const events = await auditRepository.find();
    expect(events).toHaveLength(4);

    const outcomes = events.map((event) => event.outcome).sort();
    expect(outcomes).toEqual(
      [
        UserProfileAuditOutcome.SELF_VIEW,
        UserProfileAuditOutcome.PRIVILEGED_VIEW,
        UserProfileAuditOutcome.DENIED,
        UserProfileAuditOutcome.NOT_FOUND,
      ].sort(),
    );

    for (const event of events) {
      expect(event).not.toHaveProperty('email');
      expect(event).not.toHaveProperty('photo');
      expect(JSON.stringify(event)).not.toMatch(
        /cdn\.example\.com|@example\.com/,
      );
    }

    const notFoundEvent = events.find(
      (event) => event.outcome === UserProfileAuditOutcome.NOT_FOUND,
    );
    expect(notFoundEvent?.targetId).toBe(nonexistentId);
    expect(notFoundEvent?.viewerId).toBe(privilegedUser.id);
  });
});
