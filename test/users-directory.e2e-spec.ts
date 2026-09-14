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
import { hashPassword } from '../src/modules/auth/utils/password-hasher';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { UserDirectoryAuditEvent } from '../src/modules/users/entities/user-directory-audit-event.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';

const TEST_PASSWORD = 'CorrectHorse123!';

interface DirectoryPageBody {
  items: {
    id: string;
    email: string;
    photo: string | null;
    createdAt: string;
    status: string;
    lastLoginAt: string | null;
  }[];
  nextCursor: string | null;
}

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('access_token='),
  );
  if (!cookie) {
    throw new Error('No access_token cookie found in response');
  }
  return cookie.split(';')[0];
}

describe('Admin User Directory (e2e)', () => {
  let app: INestApplication<App>;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let auditRepository: Repository<UserDirectoryAuditEvent>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let configService: ConfigService;

  let adminUser: User;
  let readerUser: User;
  let adminCookie: string;
  let readerCookie: string;

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
    auditRepository = moduleFixture.get(
      getRepositoryToken(UserDirectoryAuditEvent),
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

  // UserDirectoryAuditFilter writes 401/429/400 audit rows as a fire-and-forget
  // side effect of the exception filter (Nest does not await filter.catch()),
  // so the row can land a tick after the HTTP response is already sent.
  async function waitForAuditRows(
    matches: (events: UserDirectoryAuditEvent[]) => boolean,
    timeoutMs = 2000,
  ): Promise<UserDirectoryAuditEvent[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await auditRepository.find({
        order: { createdAt: 'ASC' },
      });
      if (matches(events) || Date.now() > deadline) {
        return events;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function seedDirectoryUsers(
    count: number,
    options: { startMinutesAgo?: number } = {},
  ): Promise<User[]> {
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const startMinutesAgo = options.startMinutesAgo ?? count + 10;
    const users: User[] = [];

    for (let i = 0; i < count; i++) {
      const createdAt = new Date(Date.now() - (startMinutesAgo - i) * 60000);
      const user = await userRepository.save(
        userRepository.create({
          email: `dir-user-${i}-${Date.now()}-${Math.random()}@example.com`,
          passwordHash,
          status:
            i % 3 === 0 ? UserStatus.PENDING_CONFIRMATION : UserStatus.ACTIVE,
          confirmedAt: new Date(),
          createdAt,
          photoUrl: i % 2 === 0 ? `https://cdn.example.com/${i}.jpg` : null,
          lastLoginAt:
            i % 4 === 0 ? null : new Date(createdAt.getTime() + 1000),
        }),
      );
      users.push(user);
    }

    return users;
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

    adminUser = await userRepository.save(
      userRepository.create({
        email: `dir-admin-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    readerUser = await userRepository.save(
      userRepository.create({
        email: `dir-reader-${Date.now()}-${Math.random()}@example.com`,
        passwordHash,
        status: UserStatus.ACTIVE,
        confirmedAt: new Date(),
      }),
    );

    const usersPermission = await permissionRepository.save(
      permissionRepository.create({
        name: 'users',
        actions: ['read', 'update', 'update-email', 'delete', 'list'],
      }),
    );

    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${Date.now()}-${Math.random()}` }),
    );
    const readerRole = await roleRepository.save(
      roleRepository.create({
        name: `reader-${Date.now()}-${Math.random()}`,
      }),
    );

    await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: usersPermission.id,
        actions: ['list'],
      }),
    );
    await grantRepository.save(
      grantRepository.create({
        roleId: readerRole.id,
        permissionId: usersPermission.id,
        actions: ['read'],
      }),
    );

    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
    );
    await userRoleRepository.save(
      userRoleRepository.create({
        userId: readerUser.id,
        roleId: readerRole.id,
      }),
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

    adminCookie = await login(adminUser);
    readerCookie = await login(readerUser);

    clearThrottler();
    await auditRepository.createQueryBuilder().delete().execute();
  });

  describe('Scenario 1 — first page (US1, P1)', () => {
    it('returns a full page of allow-listed items with a cursor when more rows exist', async () => {
      await seedDirectoryUsers(25);

      const response = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      expect(body.items).toHaveLength(20);
      expect(typeof body.nextCursor).toBe('string');

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(
          ['id', 'email', 'photo', 'createdAt', 'status', 'lastLoginAt'].sort(),
        );
      }
      expect(JSON.stringify(body)).not.toContain('passwordHash');
    });

    it('returns a disjoint, idempotent next page and null cursor on the last page', async () => {
      await seedDirectoryUsers(25);

      const firstResponse = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(200);
      const firstPage = firstResponse.body as DirectoryPageBody;

      const secondResponseA = await request(app.getHttpServer())
        .get(`/users?cursor=${encodeURIComponent(firstPage.nextCursor!)}`)
        .set('Cookie', adminCookie)
        .expect(200);
      const secondResponseB = await request(app.getHttpServer())
        .get(`/users?cursor=${encodeURIComponent(firstPage.nextCursor!)}`)
        .set('Cookie', adminCookie)
        .expect(200);

      const secondPageA = secondResponseA.body as DirectoryPageBody;
      const secondPageB = secondResponseB.body as DirectoryPageBody;

      const firstIds = firstPage.items.map((i) => i.id);
      const secondIdsA = secondPageA.items.map((i) => i.id);
      const secondIdsB = secondPageB.items.map((i) => i.id);

      expect(secondIdsA).toEqual(secondIdsB);
      expect(firstIds.some((id) => secondIdsA.includes(id))).toBe(false);
      expect(secondPageA.nextCursor).toBeNull();
    });

    it('returns nextCursor null on the first call when total users are within the limit', async () => {
      const response = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      // Only adminUser + readerUser exist at this point.
      expect(body.items.length).toBeLessThanOrEqual(20);
      expect(body.nextCursor).toBeNull();
    });
  });

  describe('Scenario 2 — search, filter, sort (US2, P1)', () => {
    let alice: User;
    let bob: User;
    let carol: User;

    beforeEach(async () => {
      const passwordHash = await hashPassword(TEST_PASSWORD);
      alice = await userRepository.save(
        userRepository.create({
          email: `alice-search-${Date.now()}@example.com`,
          passwordHash,
          status: UserStatus.ACTIVE,
          confirmedAt: new Date(),
        }),
      );
      bob = await userRepository.save(
        userRepository.create({
          email: `bob-search-${Date.now()}@example.com`,
          passwordHash,
          status: UserStatus.PENDING_CONFIRMATION,
        }),
      );
      carol = await userRepository.save(
        userRepository.create({
          email: `carol-search-${Date.now()}@example.com`,
          passwordHash,
          status: UserStatus.ACTIVE,
          confirmedAt: new Date(),
        }),
      );
    });

    it('matches by email substring, case-insensitively', async () => {
      const response = await request(app.getHttpServer())
        .get(`/users?search=${encodeURIComponent('ALICE-SEARCH')}`)
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      expect(body.items.map((i) => i.id)).toEqual([alice.id]);
    });

    it('matches by exact account id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/users?search=${bob.id}`)
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      expect(body.items.map((i) => i.id)).toEqual([bob.id]);
    });

    it('filters by status and sorts by email ascending', async () => {
      const response = await request(app.getHttpServer())
        .get('/users?status=pending_confirmation&sort=email&direction=asc')
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      expect(body.items.every((i) => i.status === 'pending_confirmation')).toBe(
        true,
      );
      expect(body.items.map((i) => i.id)).toContain(bob.id);
    });

    it('combines search and status conjunctively', async () => {
      const response = await request(app.getHttpServer())
        .get(`/users?search=${encodeURIComponent('-search-')}&status=active`)
        .set('Cookie', adminCookie)
        .expect(200);

      const body = response.body as DirectoryPageBody;
      const ids = body.items.map((i) => i.id);
      expect(ids).toContain(alice.id);
      expect(ids).toContain(carol.id);
      expect(ids).not.toContain(bob.id);
    });
  });

  describe('Scenario 3 — denied without listing rights (US3, P1)', () => {
    it('rejects a reader (users.read only) with 403 and no items', async () => {
      const response = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', readerCookie)
        .expect(403);

      expect(response.body).not.toHaveProperty('items');
    });

    it('rejects an anonymous caller with 401 and no items', async () => {
      const response = await request(app.getHttpServer())
        .get('/users')
        .expect(401);

      expect(response.body).not.toHaveProperty('items');
    });

    it('still allows the reader to fetch a single profile via users.read', async () => {
      await request(app.getHttpServer())
        .get(`/users/${adminUser.id}`)
        .set('Cookie', readerCookie)
        .expect(200);
    });
  });

  describe('Scenario 4 — invalid options (US4, P2)', () => {
    it.each([
      ['limit=0', '/users?limit=0'],
      ['limit=101', '/users?limit=101'],
      ['status=blocked', '/users?status=blocked'],
      ['sort=displayName', '/users?sort=displayName'],
      ['direction=up', '/users?direction=up'],
      ['cursor=not-a-token', '/users?cursor=not-a-token'],
    ])('rejects %s with 400 and no items', async (_label, path) => {
      clearThrottler();
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Cookie', adminCookie)
        .expect(400);

      expect(response.body).not.toHaveProperty('items');
    });

    it('rejects a page-1 cursor reused with a different search (fingerprint mismatch)', async () => {
      await seedDirectoryUsers(25);

      const firstResponse = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(200);
      const firstPage = firstResponse.body as DirectoryPageBody;

      await request(app.getHttpServer())
        .get(
          `/users?search=zzz&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        )
        .set('Cookie', adminCookie)
        .expect(400);
    });
  });

  describe('Scenario 5 — audit trail (US5, P3)', () => {
    it('records one row per attempt without PII, matching each outcome', async () => {
      await seedDirectoryUsers(5);

      clearThrottler();
      const successResponse = await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(200);
      const successBody = successResponse.body as DirectoryPageBody;

      clearThrottler();
      await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', readerCookie)
        .expect(403);

      clearThrottler();
      await request(app.getHttpServer()).get('/users').expect(401);

      clearThrottler();
      await request(app.getHttpServer())
        .get('/users?limit=0')
        .set('Cookie', adminCookie)
        .expect(400);

      const events = await waitForAuditRows((rows) => rows.length >= 4);

      expect(events).toHaveLength(4);
      expect(events.map((e) => e.outcome)).toEqual([
        'success',
        'denied',
        'unauthenticated',
        'invalid',
      ]);

      const successEvent = events[0];
      expect(successEvent.actorId).toBe(adminUser.id);
      expect(successEvent.resultCount).toBe(successBody.items.length);

      const deniedEvent = events[1];
      expect(deniedEvent.actorId).toBe(readerUser.id);

      const unauthenticatedEvent = events[2];
      expect(unauthenticatedEvent.actorId).toBeNull();

      const invalidEvent = events[3];
      expect(invalidEvent.actorId).toBe(adminUser.id);

      const dump = JSON.stringify(events);
      expect(dump).not.toContain(adminUser.email);
      expect(dump).not.toContain(readerUser.email);
    });
  });

  describe('Scenario 6 — rate limiting (US5, P3)', () => {
    it('returns 429 after exceeding the per-route throttle and audits rate_limited', async () => {
      clearThrottler();

      for (let i = 0; i < 30; i++) {
        await request(app.getHttpServer())
          .get('/users')
          .set('Cookie', adminCookie)
          .expect(200);
      }

      await request(app.getHttpServer())
        .get('/users')
        .set('Cookie', adminCookie)
        .expect(429);

      const events = await waitForAuditRows((rows) =>
        rows.some((e) => e.outcome === ('rate_limited' as never)),
      );
      const rateLimitedEvents = events.filter(
        (e) => e.outcome === ('rate_limited' as never),
      );
      expect(rateLimitedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Scenario 7 — deletion while paging', () => {
    it('drops a row that starts deleting between two pages', async () => {
      await seedDirectoryUsers(25);

      const firstResponse = await request(app.getHttpServer())
        .get('/users?limit=10')
        .set('Cookie', adminCookie)
        .expect(200);
      const firstPage = firstResponse.body as DirectoryPageBody;
      expect(firstPage.nextCursor).not.toBeNull();

      // Look ahead at the page the cursor is about to return, and mark one of
      // *those* rows mid-deletion. Picking a row from page 1 would prove
      // nothing: keyset pagination never revisits it either way.
      const previewResponse = await request(app.getHttpServer())
        .get(
          `/users?limit=10&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        )
        .set('Cookie', adminCookie)
        .expect(200);
      const preview = previewResponse.body as DirectoryPageBody;
      expect(preview.items.length).toBeGreaterThan(1);

      const targetId = preview.items[0].id;
      await userRepository.update(
        { id: targetId },
        { deletionStartedAt: new Date() },
      );

      const secondResponse = await request(app.getHttpServer())
        .get(
          `/users?limit=10&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        )
        .set('Cookie', adminCookie)
        .expect(200);
      const secondPage = secondResponse.body as DirectoryPageBody;

      expect(preview.items.map((i) => i.id)).toContain(targetId);
      expect(secondPage.items.map((i) => i.id)).not.toContain(targetId);

      const firstIds = firstPage.items.map((i) => i.id);
      expect(secondPage.items.some((item) => firstIds.includes(item.id))).toBe(
        false,
      );
    });

    it('hides mid-deletion rows from the very first page too', async () => {
      const directoryUsers = await seedDirectoryUsers(5);

      const beforeResponse = await request(app.getHttpServer())
        .get('/users?limit=50')
        .set('Cookie', adminCookie)
        .expect(200);
      const before = beforeResponse.body as DirectoryPageBody;

      const targetId = directoryUsers[0].id;
      expect(before.items.map((i) => i.id)).toContain(targetId);

      await userRepository.update(
        { id: targetId },
        { deletionStartedAt: new Date() },
      );

      const afterResponse = await request(app.getHttpServer())
        .get('/users?limit=50')
        .set('Cookie', adminCookie)
        .expect(200);
      const after = afterResponse.body as DirectoryPageBody;

      expect(after.items.map((i) => i.id)).not.toContain(targetId);
      expect(after.items).toHaveLength(before.items.length - 1);
    });

    it('does not surface a mid-deletion row through search or by id', async () => {
      const directoryUsers = await seedDirectoryUsers(3);
      const target = directoryUsers[0];

      await userRepository.update(
        { id: target.id },
        { deletionStartedAt: new Date() },
      );

      const byEmail = await request(app.getHttpServer())
        .get(`/users?search=${encodeURIComponent(target.email)}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect((byEmail.body as DirectoryPageBody).items).toHaveLength(0);

      const byId = await request(app.getHttpServer())
        .get(`/users?search=${target.id}`)
        .set('Cookie', adminCookie)
        .expect(200);
      expect((byId.body as DirectoryPageBody).items).toHaveLength(0);
    });
  });

  describe('Sub-millisecond createdAt pagination (regression)', () => {
    // Rows created by `now()`/`clock_timestamp()` carry microseconds, which the
    // pg driver drops when it materialises a JS Date. A cursor built from that
    // truncated value used to loop forever (ASC) or skip rows (DESC).
    async function seedMicrosecondUsers(count: number): Promise<string[]> {
      const passwordHash = await hashPassword(TEST_PASSWORD);
      const stamp = `${Date.now()}-${Math.random()}`;
      const ids: string[] = [];

      for (let i = 0; i < count; i++) {
        const rows: { id: string }[] = await userRepository.query(
          `INSERT INTO users (email, password_hash, status, confirmed_at, created_at, updated_at)
           VALUES ($1, $2, 'active', clock_timestamp(), clock_timestamp(), clock_timestamp())
           RETURNING id`,
          [`micro-${i}-${stamp}@example.com`, passwordHash],
        );
        ids.push(rows[0].id);
      }

      return ids;
    }

    async function pageThrough(direction: 'asc' | 'desc'): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 20; page++) {
        const query = `/users?limit=3&sort=createdAt&direction=${direction}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`;
        const response = await request(app.getHttpServer())
          .get(query)
          .set('Cookie', adminCookie)
          .expect(200);
        const body = response.body as DirectoryPageBody;

        for (const item of body.items) {
          expect(seen).not.toContain(item.id);
          seen.push(item.id);
        }

        cursor = body.nextCursor;
        if (!cursor) {
          return seen;
        }
      }

      throw new Error('Pagination did not terminate within 20 pages');
    }

    it('reaches every row when paging ascending', async () => {
      const ids = await seedMicrosecondUsers(10);
      const seen = await pageThrough('asc');
      expect(ids.every((id) => seen.includes(id))).toBe(true);
    });

    it('reaches every row when paging descending', async () => {
      const ids = await seedMicrosecondUsers(10);
      const seen = await pageThrough('desc');
      expect(ids.every((id) => seen.includes(id))).toBe(true);
    });
  });
});
