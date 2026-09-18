import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
import {
  ConversionErrorCategory,
  ConversionFormat,
  ConversionOutcome,
  ConversionRetentionOutcome,
  ImageFormat,
  RecordedFormat,
  TransformationType,
} from '../src/modules/conversion/conversion.enums';
import { ConversionRecord } from '../src/modules/conversion/entities/conversion-record.entity';
import {
  TransformationHistoryAuditEvent,
  TransformationHistoryAuditOutcome,
} from '../src/modules/transformation-history/entities/transformation-history-audit-event.entity';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';

const TEST_PASSWORD = 'CorrectHorse123!';
const SELF_PATH = '/api/transformations/history';
const adminPath = (userId: string) => `/api/transformations/history/${userId}`;
const MISSING_USER_ID = '00000000-0000-4000-8000-0000000000ff';

interface HistoryItem {
  id: string;
  type: string;
  sourceFormat: string | null;
  targetFormat: string | null;
  status: string;
  fileSize: number;
  durationMs: number;
  errorCode?: string;
  createdAt: string;
}

interface HistoryPageBody {
  items: HistoryItem[];
  nextCursor: string | null;
}

interface RowSpec {
  transformationType?: TransformationType;
  sourceFormat?: RecordedFormat | null;
  targetFormat?: RecordedFormat | null;
  outcome?: ConversionOutcome;
  errorCategory?: ConversionErrorCategory | null;
  inputSizeBytes?: number;
  durationMs?: number;
  minutesAgo?: number;
  createdAt?: Date;
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

describe('Transformation History (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let roleRepository: Repository<Role>;
  let permissionRepository: Repository<Permission>;
  let grantRepository: Repository<Grant>;
  let userRoleRepository: Repository<UserRole>;
  let userRepository: Repository<User>;
  let recordRepository: Repository<ConversionRecord>;
  let auditRepository: Repository<TransformationHistoryAuditEvent>;
  let accessConfigService: AccessConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let configService: ConfigService;

  let adminUser: User;
  let subjectUser: User;
  let outsiderUser: User;
  let adminCookie: string;
  let subjectCookie: string;
  let outsiderCookie: string;

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
    // Listen for real: concurrent supertest calls against one un-listened
    // server object interleave onto the same ephemeral socket and produce
    // bogus parse errors.
    await app.listen(0, '127.0.0.1');
    await app.getHttpAdapter().getInstance().ready();
    baseUrl = await app.getUrl();

    roleRepository = moduleFixture.get(getRepositoryToken(Role));
    permissionRepository = moduleFixture.get(getRepositoryToken(Permission));
    grantRepository = moduleFixture.get(getRepositoryToken(Grant));
    userRoleRepository = moduleFixture.get(getRepositoryToken(UserRole));
    userRepository = moduleFixture.get(getRepositoryToken(User));
    recordRepository = moduleFixture.get(getRepositoryToken(ConversionRecord));
    auditRepository = moduleFixture.get(
      getRepositoryToken(TransformationHistoryAuditEvent),
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

  /**
   * The filter-driven rows (401/400/429) are written fire-and-forget — Nest
   * does not await `filter.catch()` — so one can land a tick after the HTTP
   * response has already been sent.
   */
  async function waitForAuditRows(
    expectedCount: number,
    timeoutMs = 3000,
  ): Promise<TransformationHistoryAuditEvent[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await auditRepository.find({
        order: { createdAt: 'ASC' },
      });
      if (events.length >= expectedCount || Date.now() > deadline) {
        return events;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Fixture rows go in through the repository rather than through the real
   * conversion endpoints: this suite is about the read contract, and driving
   * two conversion pipelines to produce a controlled spread of formats,
   * outcomes and timestamps would test them instead.
   */
  async function seedHistoryRows(
    userId: string,
    specs: RowSpec[],
  ): Promise<ConversionRecord[]> {
    const saved: ConversionRecord[] = [];

    for (const [index, spec] of specs.entries()) {
      const outcome = spec.outcome ?? ConversionOutcome.SUCCESS;
      const failed = outcome === ConversionOutcome.FAILURE;
      const createdAt =
        spec.createdAt ??
        new Date(
          Date.now() - (spec.minutesAgo ?? specs.length - index) * 60000,
        );

      saved.push(
        await recordRepository.save(
          recordRepository.create({
            userId,
            transformationType:
              spec.transformationType ?? TransformationType.FILE,
            originalFileName: `fixture-${index}.dat`,
            sourceFormat:
              spec.sourceFormat === undefined
                ? ConversionFormat.CSV
                : spec.sourceFormat,
            targetFormat:
              spec.targetFormat === undefined
                ? ConversionFormat.JSON
                : spec.targetFormat,
            inputSizeBytes: String(spec.inputSizeBytes ?? 20480),
            outputSizeBytes: failed ? null : 1024,
            outcome,
            errorCategory: failed
              ? (spec.errorCategory ?? ConversionErrorCategory.TIMEOUT)
              : null,
            failureReason: failed ? 'timeout' : null,
            retentionRequested: false,
            retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
            storedFileId: null,
            startedAt: createdAt,
            durationMs: spec.durationMs ?? 42,
            createdAt,
          }),
        ),
      );
    }

    return saved;
  }

  beforeEach(async () => {
    clearThrottler();

    await auditRepository.createQueryBuilder().delete().execute();
    await recordRepository.createQueryBuilder().delete().execute();
    await userRoleRepository.createQueryBuilder().delete().execute();
    await grantRepository.createQueryBuilder().delete().execute();
    await permissionRepository.createQueryBuilder().delete().execute();
    await roleRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();

    const passwordHash = await hashPassword(TEST_PASSWORD);
    const makeUser = (prefix: string) =>
      userRepository.save(
        userRepository.create({
          email: `th-${prefix}-${Date.now()}-${Math.random()}@example.com`,
          passwordHash,
          status: UserStatus.ACTIVE,
          confirmedAt: new Date(),
        }),
      );

    adminUser = await makeUser('admin');
    subjectUser = await makeUser('subject');
    outsiderUser = await makeUser('outsider');

    const historyPermission = await permissionRepository.save(
      permissionRepository.create({
        name: 'transformation-history',
        actions: ['read-any'],
      }),
    );

    const adminRole = await roleRepository.save(
      roleRepository.create({ name: `admin-${Date.now()}-${Math.random()}` }),
    );
    const plainRole = await roleRepository.save(
      roleRepository.create({ name: `plain-${Date.now()}-${Math.random()}` }),
    );

    await grantRepository.save(
      grantRepository.create({
        roleId: adminRole.id,
        permissionId: historyPermission.id,
        actions: ['read-any'],
      }),
    );

    await userRoleRepository.save(
      userRoleRepository.create({ userId: adminUser.id, roleId: adminRole.id }),
    );
    // Holds a role, but not this permission — so a 403 proves the permission
    // is checked, not merely that the caller has no roles at all.
    await userRoleRepository.save(
      userRoleRepository.create({
        userId: outsiderUser.id,
        roleId: plainRole.id,
      }),
    );

    await accessConfigService.reload();

    const login = async (user: User) => {
      const response = await request(baseUrl)
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return extractSessionCookie(
        response.headers['set-cookie'] as unknown as string[],
      );
    };

    adminCookie = await login(adminUser);
    subjectCookie = await login(subjectUser);
    outsiderCookie = await login(outsiderUser);

    clearThrottler();
    await auditRepository.createQueryBuilder().delete().execute();
  });

  describe('Scenario 1 — a user reads their own history (US1, P1)', () => {
    it('returns only the caller s own records, newest first', async () => {
      await seedHistoryRows(subjectUser.id, [
        { minutesAgo: 30, transformationType: TransformationType.FILE },
        {
          minutesAgo: 20,
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
        },
        { minutesAgo: 10, transformationType: TransformationType.FILE },
      ]);
      await seedHistoryRows(outsiderUser.id, [{ minutesAgo: 5 }]);

      const response = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);

      const body = response.body as HistoryPageBody;
      const own = await recordRepository.find({
        where: { userId: subjectUser.id },
      });

      expect(body.items).toHaveLength(3);
      expect(body.items.map((item) => item.id).sort()).toEqual(
        own.map((row) => row.id).sort(),
      );

      const timestamps = body.items.map((item) => Date.parse(item.createdAt));
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

      // Both families are in one history, not two.
      expect(body.items.map((item) => item.type).sort()).toEqual([
        'file',
        'file',
        'image',
      ]);
    });

    it('returns every record with a null cursor when the history fits one page', async () => {
      await seedHistoryRows(subjectUser.id, [{}, {}, {}]);

      const response = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);

      const body = response.body as HistoryPageBody;
      expect(body.items).toHaveLength(3);
      expect(body.nextCursor).toBeNull();
    });

    it('exposes exactly the allow-listed fields and nothing else', async () => {
      await seedHistoryRows(subjectUser.id, [
        { inputSizeBytes: 20480, durationMs: 42 },
        {
          outcome: ConversionOutcome.FAILURE,
          errorCategory: ConversionErrorCategory.TIMEOUT,
        },
      ]);

      const response = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);

      const body = response.body as HistoryPageBody;

      for (const item of body.items) {
        const expected = [
          'createdAt',
          'durationMs',
          'fileSize',
          'id',
          'sourceFormat',
          'status',
          'targetFormat',
          'type',
        ];
        if (item.status === 'error') {
          expected.push('errorCode');
        }
        expect(Object.keys(item).sort()).toEqual(expected.sort());
      }

      // FR-014: nothing in the payload can name a file or quote a parser.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('fixture-');
      expect(serialized).not.toContain('originalFileName');
      expect(serialized).not.toContain('failureReason');
      expect(serialized).not.toContain(subjectUser.email);

      const success = body.items.find((item) => item.status === 'success');
      expect(success).toMatchObject({ fileSize: 20480, durationMs: 42 });
      expect(success && 'errorCode' in success).toBe(false);
    });

    it('returns an empty page, not an error, for a user with no history', async () => {
      const response = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);

      expect(response.body).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('Scenario 2 — an admin reads a specific user s history (US2, P1)', () => {
    it('returns only the target s records, formatted exactly as the self route does', async () => {
      await seedHistoryRows(subjectUser.id, [
        { minutesAgo: 30 },
        {
          minutesAgo: 20,
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
        },
      ]);
      await seedHistoryRows(outsiderUser.id, [{ minutesAgo: 10 }]);

      const asAdmin = await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(200);

      const asSelf = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);

      expect(asAdmin.body).toEqual(asSelf.body);
      expect((asAdmin.body as HistoryPageBody).items).toHaveLength(2);
    });

    it('returns 404 for a well-formed id that belongs to no account', async () => {
      await request(baseUrl)
        .get(adminPath(MISSING_USER_ID))
        .set('Cookie', adminCookie)
        .expect(404);
    });

    it('returns 400 for a userId that is not a UUID', async () => {
      await request(baseUrl)
        .get(adminPath('not-a-uuid'))
        .set('Cookie', adminCookie)
        .expect(400);
    });
  });

  describe('Scenario 3 — the authorization boundary (US3, P1)', () => {
    it('refuses a caller without the permission, whether or not the target exists', async () => {
      await seedHistoryRows(subjectUser.id, [{}]);

      const existing = await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', outsiderCookie)
        .expect(403);

      const missing = await request(baseUrl)
        .get(adminPath(MISSING_USER_ID))
        .set('Cookie', outsiderCookie)
        .expect(403);

      // Identical answers: the pair is what makes the route useless as an
      // account-existence oracle.
      for (const response of [existing, missing]) {
        expect(response.body).not.toHaveProperty('items');
        expect(JSON.stringify(response.body)).not.toContain(subjectUser.email);
      }
      expect(existing.body).toEqual(missing.body);
    });

    it('requires authentication on both routes', async () => {
      await request(baseUrl).get(SELF_PATH).expect(401);
      await request(baseUrl).get(adminPath(subjectUser.id)).expect(401);
    });

    it('lets a caller holding no oversight permission read their own history', async () => {
      await seedHistoryRows(outsiderUser.id, [{}, {}]);

      const response = await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', outsiderCookie)
        .expect(200);

      expect((response.body as HistoryPageBody).items).toHaveLength(2);
    });
  });

  describe('Scenario 4 — narrowing history with filters (US4, P2)', () => {
    const DAY_1 = new Date('2026-09-10T10:00:00.000Z');
    const DAY_2 = new Date('2026-09-11T10:00:00.000Z');
    const DAY_3 = new Date('2026-09-12T10:00:00.000Z');

    beforeEach(async () => {
      await seedHistoryRows(subjectUser.id, [
        { createdAt: DAY_1 },
        {
          createdAt: DAY_2,
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
        },
        {
          createdAt: DAY_3,
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.SVG,
          outcome: ConversionOutcome.FAILURE,
          errorCategory: ConversionErrorCategory.TIMEOUT,
        },
      ]);
    });

    async function fetchSelf(queryString: string): Promise<HistoryPageBody> {
      const response = await request(baseUrl)
        .get(`${SELF_PATH}?${queryString}`)
        .set('Cookie', subjectCookie)
        .expect(200);
      return response.body as HistoryPageBody;
    }

    it('filters by type', async () => {
      const images = await fetchSelf('type=image');
      expect(images.items).toHaveLength(2);
      expect(images.items.every((item) => item.type === 'image')).toBe(true);

      const files = await fetchSelf('type=file');
      expect(files.items).toHaveLength(1);
      expect(files.items[0].type).toBe('file');
    });

    it('filters by source and target format', async () => {
      expect((await fetchSelf('sourceFormat=png')).items).toHaveLength(2);
      expect((await fetchSelf('targetFormat=jpeg')).items).toHaveLength(1);
      expect((await fetchSelf('sourceFormat=csv')).items).toHaveLength(1);
    });

    it('filters by status, and only error items carry an errorCode', async () => {
      const errors = await fetchSelf('status=error');
      expect(errors.items).toHaveLength(1);
      expect(errors.items[0].errorCode).toBe(ConversionErrorCategory.TIMEOUT);

      const successes = await fetchSelf('status=success');
      expect(successes.items).toHaveLength(2);
      expect(successes.items.every((item) => !('errorCode' in item))).toBe(
        true,
      );
    });

    it('treats both ends of the date range as inclusive', async () => {
      const spanning = await fetchSelf(
        `createdAtFrom=${DAY_2.toISOString()}&createdAtTo=${DAY_3.toISOString()}`,
      );
      expect(spanning.items).toHaveLength(2);

      // A single-instant range still returns the row on that instant.
      const pinpoint = await fetchSelf(
        `createdAtFrom=${DAY_2.toISOString()}&createdAtTo=${DAY_2.toISOString()}`,
      );
      expect(pinpoint.items).toHaveLength(1);
    });

    it('combines filters so every returned record satisfies all of them', async () => {
      const combined = await fetchSelf(
        `type=image&sourceFormat=png&status=success&createdAtFrom=${DAY_1.toISOString()}`,
      );

      expect(combined.items).toHaveLength(1);
      expect(combined.items[0]).toMatchObject({
        type: 'image',
        sourceFormat: 'png',
        status: 'success',
      });
    });

    it('returns an empty page, not an error, when a combination matches nothing', async () => {
      await expect(fetchSelf('type=file&sourceFormat=png')).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it('filters identically on the admin route', async () => {
      const asAdmin = await request(baseUrl)
        .get(`${adminPath(subjectUser.id)}?type=image&status=success`)
        .set('Cookie', adminCookie)
        .expect(200);

      const asSelf = await fetchSelf('type=image&status=success');

      expect(asAdmin.body).toEqual(asSelf);
    });
  });

  describe('Scenario 5 — invalid requests are rejected (US5, P2)', () => {
    it.each([
      ['a page size above the maximum', 'limit=500'],
      ['a page size below the minimum', 'limit=0'],
      ['an unrecognized type', 'type=archive'],
      ['an unrecognized source format', 'sourceFormat=tiff'],
      ['an unrecognized status', 'status=failure'],
      ['a malformed cursor', 'cursor=not-a-real-cursor'],
      ['a malformed date', 'createdAtFrom=yesterday'],
      [
        'an inverted date range',
        'createdAtFrom=2026-09-12T00:00:00.000Z&createdAtTo=2026-09-10T00:00:00.000Z',
      ],
    ])('rejects %s with 400 and no history payload', async (_name, qs) => {
      await seedHistoryRows(subjectUser.id, [{}]);

      const response = await request(baseUrl)
        .get(`${SELF_PATH}?${qs}`)
        .set('Cookie', subjectCookie)
        .expect(400);

      expect(response.body).not.toHaveProperty('items');
    });

    it('rejects the same invalid input on the admin route', async () => {
      await request(baseUrl)
        .get(`${adminPath(subjectUser.id)}?limit=500`)
        .set('Cookie', adminCookie)
        .expect(400);
    });
  });

  describe('Scenario 6 — repeating a request is idempotent (FR-009)', () => {
    it('returns byte-identical pages for a repeated cursor request', async () => {
      await seedHistoryRows(subjectUser.id, [
        { minutesAgo: 30 },
        { minutesAgo: 20 },
        { minutesAgo: 10 },
      ]);

      const first = await request(baseUrl)
        .get(`${SELF_PATH}?limit=1`)
        .set('Cookie', subjectCookie)
        .expect(200);

      const cursor = (first.body as HistoryPageBody).nextCursor;
      expect(cursor).not.toBeNull();

      const followUp = `${SELF_PATH}?limit=1&cursor=${encodeURIComponent(cursor as string)}`;

      const second = await request(baseUrl)
        .get(followUp)
        .set('Cookie', subjectCookie)
        .expect(200);
      const third = await request(baseUrl)
        .get(followUp)
        .set('Cookie', subjectCookie)
        .expect(200);

      expect(second.text).toEqual(third.text);
      expect((second.body as HistoryPageBody).items[0].id).not.toEqual(
        (first.body as HistoryPageBody).items[0].id,
      );
    });

    it('refuses a cursor minted while reading another user s history', async () => {
      await seedHistoryRows(subjectUser.id, [
        { minutesAgo: 20 },
        { minutesAgo: 10 },
      ]);
      await seedHistoryRows(outsiderUser.id, [
        { minutesAgo: 20 },
        { minutesAgo: 10 },
      ]);

      const forSubject = await request(baseUrl)
        .get(`${adminPath(subjectUser.id)}?limit=1`)
        .set('Cookie', adminCookie)
        .expect(200);

      const cursor = (forSubject.body as HistoryPageBody).nextCursor as string;

      await request(baseUrl)
        .get(
          `${adminPath(outsiderUser.id)}?limit=1&cursor=${encodeURIComponent(cursor)}`,
        )
        .set('Cookie', adminCookie)
        .expect(400);
    });
  });

  describe('Scenario 7 — every request is audited (US6, P3)', () => {
    it('writes one row per request, with the right outcome for each', async () => {
      await seedHistoryRows(subjectUser.id, [{}, {}]);

      // One request per reachable outcome, in-handler and filter-raised alike.
      await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);
      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(200);
      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', outsiderCookie)
        .expect(403);
      await request(baseUrl)
        .get(adminPath(MISSING_USER_ID))
        .set('Cookie', adminCookie)
        .expect(404);
      await request(baseUrl).get(SELF_PATH).expect(401);
      await request(baseUrl)
        .get(`${SELF_PATH}?limit=500`)
        .set('Cookie', subjectCookie)
        .expect(400);

      const events = await waitForAuditRows(6);

      expect(events).toHaveLength(6);
      expect(events.map((event) => event.outcome)).toEqual([
        TransformationHistoryAuditOutcome.SUCCESS,
        TransformationHistoryAuditOutcome.SUCCESS,
        TransformationHistoryAuditOutcome.DENIED,
        TransformationHistoryAuditOutcome.NOT_FOUND,
        TransformationHistoryAuditOutcome.UNAUTHENTICATED,
        TransformationHistoryAuditOutcome.INVALID,
      ]);
    });

    it('populates targetUserId only on admin-path rows and resultCount only on success', async () => {
      await seedHistoryRows(subjectUser.id, [{}, {}, {}]);

      await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(200);
      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(200);
      await request(baseUrl)
        .get(adminPath(MISSING_USER_ID))
        .set('Cookie', adminCookie)
        .expect(404);

      const [selfRead, adminRead, notFound] = await waitForAuditRows(3);

      expect(selfRead).toMatchObject({
        actorUserId: subjectUser.id,
        targetUserId: null,
        resultCount: 3,
      });
      expect(adminRead).toMatchObject({
        actorUserId: adminUser.id,
        targetUserId: subjectUser.id,
        resultCount: 3,
      });
      expect(notFound).toMatchObject({
        actorUserId: adminUser.id,
        targetUserId: MISSING_USER_ID,
        resultCount: null,
      });
    });

    it('records an unauthenticated request with no actor', async () => {
      await request(baseUrl).get(SELF_PATH).expect(401);

      const [event] = await waitForAuditRows(1);

      expect(event).toMatchObject({
        actorUserId: null,
        outcome: TransformationHistoryAuditOutcome.UNAUTHENTICATED,
      });
    });

    it('records which filter kinds were used, never their values', async () => {
      await seedHistoryRows(subjectUser.id, [
        {
          transformationType: TransformationType.IMAGE,
          sourceFormat: ImageFormat.PNG,
          targetFormat: ImageFormat.JPEG,
        },
      ]);

      await request(baseUrl)
        .get(`${SELF_PATH}?type=image&sourceFormat=png&status=success`)
        .set('Cookie', subjectCookie)
        .expect(200);

      const [event] = await waitForAuditRows(1);

      expect(event).toMatchObject({
        typeFilterUsed: true,
        sourceFormatFilterUsed: true,
        statusFilterUsed: true,
        targetFormatFilterUsed: false,
        dateRangeFilterUsed: false,
      });
      expect(JSON.stringify(event)).not.toContain('png');
    });

    it('holds no file content and no other user s identifying detail', async () => {
      await seedHistoryRows(subjectUser.id, [{}]);

      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(200);

      const serialized = JSON.stringify(await waitForAuditRows(1));

      // FR-018: the table has nowhere to put any of these.
      expect(serialized).not.toContain('fixture-');
      expect(serialized).not.toContain(subjectUser.email);
      expect(serialized).not.toContain(adminUser.email);
      expect(serialized).not.toContain('csv');
    });
  });

  describe('Scenario 8 — rate limiting (SC-008, FR-016)', () => {
    afterEach(() => {
      // Thirty-odd requests in one test is enough throttle state to change
      // what the next test sees.
      clearThrottler();
    });

    it('allows 30 self reads per minute and refuses the 31st', async () => {
      clearThrottler();

      for (let i = 0; i < 30; i++) {
        await request(baseUrl)
          .get(SELF_PATH)
          .set('Cookie', subjectCookie)
          .expect(200);
      }

      await request(baseUrl)
        .get(SELF_PATH)
        .set('Cookie', subjectCookie)
        .expect(429);
    });

    it('holds the admin route to a stricter 20 per minute', async () => {
      clearThrottler();

      for (let i = 0; i < 20; i++) {
        await request(baseUrl)
          .get(adminPath(subjectUser.id))
          .set('Cookie', adminCookie)
          .expect(200);
      }

      // FR-016: oversight is never more permissive than self-service.
      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(429);
    });

    it('audits the refusal', async () => {
      clearThrottler();
      await auditRepository.createQueryBuilder().delete().execute();

      for (let i = 0; i < 20; i++) {
        await request(baseUrl)
          .get(adminPath(subjectUser.id))
          .set('Cookie', adminCookie)
          .expect(200);
      }
      await request(baseUrl)
        .get(adminPath(subjectUser.id))
        .set('Cookie', adminCookie)
        .expect(429);

      const events = await waitForAuditRows(21);

      expect(
        events.filter(
          (event) =>
            event.outcome === TransformationHistoryAuditOutcome.RATE_LIMITED,
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('API documentation (constitution V)', () => {
    it('documents both routes with every status code the contract lists', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('check').setVersion('1').build(),
      );
      const paths = document.paths as Record<
        string,
        { get?: { tags?: string[]; responses: Record<string, unknown> } }
      >;

      const self = paths['/api/transformations/history']?.get;
      const admin = paths['/api/transformations/history/{userId}']?.get;

      expect(self).toBeDefined();
      expect(admin).toBeDefined();

      // contracts/transformation-history-api.md, per route.
      expect(Object.keys(self!.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '429',
      ]);
      expect(Object.keys(admin!.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '429',
      ]);

      expect(self!.tags).toContain('transformation-history');
      expect(admin!.tags).toContain('transformation-history');
    });

    it('publishes the response schema as the allow-list, and nothing more', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('check').setVersion('1').build(),
      );
      const schemas = document.components?.schemas as Record<
        string,
        { properties?: Record<string, unknown> }
      >;

      expect(
        Object.keys(
          schemas.TransformationHistoryItemDto.properties ?? {},
        ).sort(),
      ).toEqual([
        'createdAt',
        'durationMs',
        'errorCode',
        'fileSize',
        'id',
        'sourceFormat',
        'status',
        'targetFormat',
        'type',
      ]);

      expect(
        Object.keys(
          schemas.TransformationHistoryPageDto.properties ?? {},
        ).sort(),
      ).toEqual(['items', 'nextCursor']);
    });
  });
});
