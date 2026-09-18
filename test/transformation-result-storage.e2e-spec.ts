import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { getRepositoryToken } from '@nestjs/typeorm';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { readFileSync, type ReadStream } from 'fs';
import { access } from 'fs/promises';
import { join, resolve } from 'path';
import { PassThrough } from 'stream';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import {
  ConversionStorageReadError,
  ConversionFileStorageService,
} from '../src/core/storage/conversion-file-storage.service';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';
import { ConversionRecord } from '../src/modules/conversion/entities/conversion-record.entity';
import { ConversionStoredFile } from '../src/modules/conversion/entities/conversion-stored-file.entity';
import { AccessConfigService } from '../src/modules/rbac/access-config.service';
import { Grant } from '../src/modules/rbac/entities/grant.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { TransformationResultAuditEvent } from '../src/modules/transformation-result-storage/entities/transformation-result-audit-event.entity';
import { TransformationResultCleanupService } from '../src/modules/transformation-result-storage/transformation-result-cleanup.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from '../src/modules/transformation-result-storage/transformation-result.enums';

const TEST_PASSWORD = 'CorrectHorse123!';
const FIXTURE = join(__dirname, 'support', 'conversion-fixtures', 'sample.csv');
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ff';

function extractSessionCookie(setCookieHeader: string[] | undefined): string {
  const cookie = (setCookieHeader ?? []).find((value) =>
    value.startsWith('access_token='),
  );
  if (!cookie) {
    throw new Error('No access_token cookie found in response');
  }
  return cookie.split(';')[0];
}

describe('Transformation result storage and download (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let users: Repository<User>;
  let roles: Repository<Role>;
  let permissions: Repository<Permission>;
  let grants: Repository<Grant>;
  let userRoles: Repository<UserRole>;
  let records: Repository<ConversionRecord>;
  let storedFiles: Repository<ConversionStoredFile>;
  let audits: Repository<TransformationResultAuditEvent>;
  let storage: ConversionFileStorageService;
  let cleanup: TransformationResultCleanupService;
  let accessConfig: AccessConfigService;
  let throttler: ThrottlerStorageService;
  let permission: Permission;
  let permissionWasCreated = false;
  let originalPermissionActions: string[] = [];
  let adminGrant: Grant;
  let adminRole: Role;
  let owner: User;
  let other: User;
  let admin: User;
  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;
  const physicalPaths = new Set<string>();

  const selfPath = (itemId: string) =>
    `/api/transformations/history/${itemId}/download`;
  const adminPath = (userId: string, itemId: string) =>
    `/admin/users/${userId}/transformations/history/${itemId}/download`;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

    const config = moduleFixture.get(ConfigService);
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyCookie, { secret: config.get('COOKIE_SECRET') });
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyMultipart, {
        limits: {
          fileSize: Number(config.get('PHOTO_MAX_SIZE_BYTES')),
          files: 1,
        },
      });
    await app
      .getHttpAdapter()
      .getInstance()
      .register(fastifyStatic, {
        root: resolve(config.get('ASSETS_DIR')),
        prefix: '/assets/',
      });

    await app.init();
    await app.listen(0, '127.0.0.1');
    await app.getHttpAdapter().getInstance().ready();
    baseUrl = await app.getUrl();

    users = moduleFixture.get(getRepositoryToken(User));
    roles = moduleFixture.get(getRepositoryToken(Role));
    permissions = moduleFixture.get(getRepositoryToken(Permission));
    grants = moduleFixture.get(getRepositoryToken(Grant));
    userRoles = moduleFixture.get(getRepositoryToken(UserRole));
    records = moduleFixture.get(getRepositoryToken(ConversionRecord));
    storedFiles = moduleFixture.get(getRepositoryToken(ConversionStoredFile));
    audits = moduleFixture.get(
      getRepositoryToken(TransformationResultAuditEvent),
    );
    storage = moduleFixture.get(ConversionFileStorageService);
    cleanup = moduleFixture.get(TransformationResultCleanupService);
    accessConfig = moduleFixture.get(AccessConfigService);
    throttler = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;

    const stamp = `${Date.now()}-${Math.random()}`;
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const createUser = (name: string) =>
      users.save(
        users.create({
          email: `result-${name}-${stamp}@example.com`,
          passwordHash,
          status: UserStatus.ACTIVE,
          confirmedAt: new Date(),
        }),
      );
    owner = await createUser('owner');
    other = await createUser('other');
    admin = await createUser('admin');

    const existingPermission = await permissions.findOne({
      where: { name: 'transformation-history' },
    });
    permission =
      existingPermission ??
      (await permissions.save(
        permissions.create({
          name: 'transformation-history',
          actions: ['download-any'],
        }),
      ));
    permissionWasCreated = existingPermission === null;
    originalPermissionActions = [...permission.actions];
    if (!permission.actions.includes('download-any')) {
      permission.actions = [...permission.actions, 'download-any'];
      permission = await permissions.save(permission);
    }

    adminRole = await roles.save(
      roles.create({ name: `result-admin-${stamp}` }),
    );
    adminGrant = await grants.save(
      grants.create({
        roleId: adminRole.id,
        permissionId: permission.id,
        actions: ['download-any'],
      }),
    );
    await userRoles.save(
      userRoles.create({ userId: admin.id, roleId: adminRole.id }),
    );
    await accessConfig.reload();

    const login = async (user: User): Promise<string> => {
      const response = await request(baseUrl)
        .post('/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      return extractSessionCookie(
        response.headers['set-cookie'] as unknown as string[],
      );
    };
    ownerCookie = await login(owner);
    otherCookie = await login(other);
    adminCookie = await login(admin);
  });

  async function removeTrackedFiles(): Promise<void> {
    await Promise.all(
      [...physicalPaths].map((path) =>
        storage.remove(path).catch(() => 'missing'),
      ),
    );
    physicalPaths.clear();
  }

  async function clearFeatureRows(): Promise<void> {
    await removeTrackedFiles();
    await audits.createQueryBuilder().delete().execute();
    await records.delete([
      { userId: owner.id },
      { userId: other.id },
      { userId: admin.id },
    ]);
  }

  beforeEach(async () => {
    throttler.onApplicationShutdown();
    throttler.storage.clear();
    await clearFeatureRows();
  });

  afterAll(async () => {
    await clearFeatureRows();
    await userRoles.delete({ userId: admin.id, roleId: adminRole.id });
    await grants.delete({ id: adminGrant.id });
    await roles.delete({ id: adminRole.id });
    await users.delete([owner.id, other.id, admin.id]);
    if (permissionWasCreated) {
      await permissions.delete({ id: permission.id });
    } else if (
      JSON.stringify(permission.actions) !==
      JSON.stringify(originalPermissionActions)
    ) {
      permission.actions = originalPermissionActions;
      await permissions.save(permission);
    }
    await accessConfig.reload();
    await app.close();
  });

  async function storeDocument(
    user: User = owner,
    cookie: string = ownerCookie,
  ): Promise<{
    responseBytes: Buffer;
    record: ConversionRecord;
    stored: ConversionStoredFile;
  }> {
    const response = await request(baseUrl)
      .post('/api/convert')
      .set('Cookie', cookie)
      .attach('file', readFileSync(FIXTURE), 'sample.csv')
      .field('targetFormat', 'yaml')
      .field('store', 'true')
      .expect(200);

    const record = await records.findOneOrFail({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });
    const stored = await storedFiles.findOneOrFail({
      where: { id: record.storedFileId! },
    });
    physicalPaths.add(stored.storagePath);
    return {
      responseBytes: Buffer.from(response.text, 'utf8'),
      record,
      stored,
    };
  }

  async function createUnsaved(): Promise<ConversionRecord> {
    await request(baseUrl)
      .post('/api/convert')
      .set('Cookie', ownerCookie)
      .attach('file', readFileSync(FIXTURE), 'sample.csv')
      .field('targetFormat', 'yaml')
      .field('store', 'false')
      .expect(200);
    return records.findOneOrFail({
      where: { userId: owner.id },
      order: { createdAt: 'DESC' },
    });
  }

  async function waitForAudits(
    expected: number,
  ): Promise<TransformationResultAuditEvent[]> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const events = await audits.find({ order: { createdAt: 'ASC' } });
      if (events.length >= expected || Date.now() >= deadline) {
        return events;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  describe('self download', () => {
    it('streams exact private bytes repeatedly and concurrently', async () => {
      const saved = await storeDocument();
      await audits.createQueryBuilder().delete().execute();

      const download = () =>
        request(baseUrl)
          .get(selfPath(saved.record.id))
          .set('Cookie', ownerCookie)
          .expect(200);

      const first = await download();
      expect(Buffer.from(first.text, 'utf8')).toEqual(saved.responseBytes);
      expect(first.headers).toMatchObject({
        'content-type': 'application/yaml',
        'content-disposition': 'attachment; filename="converted.yaml"',
        'content-length': String(saved.responseBytes.length),
        'content-encoding': 'identity',
        'cache-control': 'private, no-store',
      });

      const repeated = await download();
      const concurrent = await Promise.all([
        download(),
        download(),
        download(),
      ]);
      for (const response of [repeated, ...concurrent]) {
        expect(Buffer.from(response.text, 'utf8')).toEqual(saved.responseBytes);
      }

      const events = await waitForAudits(5);
      expect(events).toHaveLength(5);
      expect(
        events.every(
          (event) =>
            event.action === TransformationResultAuditAction.DOWNLOAD &&
            event.outcome === TransformationResultAuditOutcome.SUCCESS &&
            event.actorUserId === owner.id &&
            event.conversionRecordId === saved.record.id &&
            event.storedFileId === saved.stored.id &&
            event.fileSizeBytes === saved.responseBytes.length,
        ),
      ).toBe(true);
    });

    it('uses one unavailable response for unknown, unsaved, cross-owner, expired, and drifted results', async () => {
      const saved = await storeDocument();
      const unsaved = await createUnsaved();
      const otherSaved = await storeDocument(other, otherCookie);
      const drifted = await storeDocument();
      await records
        .createQueryBuilder()
        .update()
        .set({
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        })
        .where('id = :id', { id: saved.record.id })
        .execute();
      await storage.remove(drifted.stored.storagePath);
      await audits.createQueryBuilder().delete().execute();

      const calls = [
        selfPath(UNKNOWN_ID),
        selfPath(unsaved.id),
        selfPath(otherSaved.record.id),
        selfPath(saved.record.id),
        selfPath(drifted.record.id),
      ];
      for (const path of calls) {
        const response = await request(baseUrl)
          .get(path)
          .set('Cookie', ownerCookie)
          .expect(404);
        expect(response.body).toEqual({
          statusCode: 404,
          message: 'Transformation result not available',
        });
      }

      const events = await waitForAudits(5);
      expect(events.map((event) => event.outcome)).toEqual([
        TransformationResultAuditOutcome.NOT_FOUND,
        TransformationResultAuditOutcome.NOT_FOUND,
        TransformationResultAuditOutcome.NOT_FOUND,
        TransformationResultAuditOutcome.EXPIRED,
        TransformationResultAuditOutcome.UNAVAILABLE,
      ]);
    });

    it('authenticates before lookup and validates the history id', async () => {
      await request(baseUrl).get(selfPath(UNKNOWN_ID)).expect(401);
      await request(baseUrl)
        .get(selfPath('not-a-uuid'))
        .set('Cookie', ownerCookie)
        .expect(400);

      const events = await waitForAudits(2);
      expect(events.map((event) => event.outcome).sort()).toEqual([
        TransformationResultAuditOutcome.INVALID,
        TransformationResultAuditOutcome.UNAUTHENTICATED,
      ]);
    });
  });

  describe('administrator download', () => {
    it('enforces download-any before target lookup and supports revocation', async () => {
      const saved = await storeDocument();
      await audits.createQueryBuilder().delete().execute();

      const allowed = await request(baseUrl)
        .get(adminPath(owner.id, saved.record.id))
        .set('Cookie', adminCookie)
        .expect(200);
      expect(Buffer.from(allowed.text, 'utf8')).toEqual(saved.responseBytes);

      const realTarget = await request(baseUrl)
        .get(adminPath(owner.id, saved.record.id))
        .set('Cookie', otherCookie)
        .expect(403);
      const randomTarget = await request(baseUrl)
        .get(adminPath(UNKNOWN_ID, UNKNOWN_ID))
        .set('Cookie', otherCookie)
        .expect(403);
      expect(realTarget.body).toEqual(randomTarget.body);

      await request(baseUrl)
        .get(adminPath(other.id, saved.record.id))
        .set('Cookie', adminCookie)
        .expect(404);
      await request(baseUrl)
        .get(adminPath(UNKNOWN_ID, saved.record.id))
        .set('Cookie', adminCookie)
        .expect(404);

      await grants.delete({ id: adminGrant.id });
      await accessConfig.reload();
      await request(baseUrl)
        .get(adminPath(owner.id, saved.record.id))
        .set('Cookie', adminCookie)
        .expect(403);
      adminGrant = await grants.save(
        grants.create({
          roleId: adminRole.id,
          permissionId: permission.id,
          actions: ['download-any'],
        }),
      );
      await accessConfig.reload();

      const events = await waitForAudits(6);
      expect(events.map((event) => event.outcome)).toEqual([
        TransformationResultAuditOutcome.SUCCESS,
        TransformationResultAuditOutcome.DENIED,
        TransformationResultAuditOutcome.DENIED,
        TransformationResultAuditOutcome.NOT_FOUND,
        TransformationResultAuditOutcome.NOT_FOUND,
        TransformationResultAuditOutcome.DENIED,
      ]);
    });

    it('validates both ids and requires authentication', async () => {
      await request(baseUrl)
        .get(adminPath('not-a-uuid', UNKNOWN_ID))
        .set('Cookie', adminCookie)
        .expect(400);
      await request(baseUrl)
        .get(adminPath(owner.id, 'not-a-uuid'))
        .set('Cookie', adminCookie)
        .expect(400);
      await request(baseUrl).get(adminPath(owner.id, UNKNOWN_ID)).expect(401);
    });
  });

  describe('expiry and cleanup', () => {
    it('removes expired saved and unsaved rows, linked metadata, and files; missing files are idempotent', async () => {
      const saved = await storeDocument();
      const missing = await storeDocument();
      const unsaved = await createUnsaved();
      await storage.remove(missing.stored.storagePath);
      await records
        .createQueryBuilder()
        .update()
        .set({
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        })
        .whereInIds([saved.record.id, missing.record.id, unsaved.id])
        .execute();

      await request(baseUrl)
        .get(selfPath(saved.record.id))
        .set('Cookie', ownerCookie)
        .expect(404);

      await expect(cleanup.runCleanupCycle()).resolves.toEqual({
        deleted: 3,
        failed: 0,
      });
      await expect(
        records.findByIds([saved.record.id, missing.record.id, unsaved.id]),
      ).resolves.toHaveLength(0);
      await expect(
        storedFiles.findByIds([saved.stored.id, missing.stored.id]),
      ).resolves.toHaveLength(0);
      await expect(
        access(join(storage.root(), saved.stored.storagePath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('continues after one unlink failure and retries the retained row later', async () => {
      const failed = await storeDocument();
      const later = await storeDocument();
      await records
        .createQueryBuilder()
        .update()
        .set({
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 2000),
        })
        .where('id = :id', { id: failed.record.id })
        .execute();
      await records
        .createQueryBuilder()
        .update()
        .set({
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 1000),
        })
        .where('id = :id', { id: later.record.id })
        .execute();

      const realRemove = storage.remove.bind(storage);
      const remove = jest
        .spyOn(storage, 'remove')
        .mockImplementation((path) => {
          if (path === failed.stored.storagePath) {
            return Promise.reject(new Error('simulated unlink failure'));
          }
          return realRemove(path);
        });

      await expect(cleanup.runCleanupCycle()).resolves.toEqual({
        deleted: 1,
        failed: 1,
      });
      expect(await records.exist({ where: { id: failed.record.id } })).toBe(
        true,
      );
      expect(await records.exist({ where: { id: later.record.id } })).toBe(
        false,
      );

      remove.mockRestore();
      await expect(cleanup.runCleanupCycle()).resolves.toEqual({
        deleted: 1,
        failed: 0,
      });
      expect(await records.exist({ where: { id: failed.record.id } })).toBe(
        false,
      );
    });
  });

  describe('failure, audit, and privacy boundaries', () => {
    it('maps unexpected preflight storage errors to 500 without internals', async () => {
      const saved = await storeDocument();
      await audits.createQueryBuilder().delete().execute();
      const open = jest
        .spyOn(storage, 'openForRead')
        .mockRejectedValue(
          new ConversionStorageReadError(new Error('/secret')),
        );

      try {
        const response = await request(baseUrl)
          .get(selfPath(saved.record.id))
          .set('Cookie', ownerCookie)
          .expect(500);
        expect(JSON.stringify(response.body)).not.toContain('/secret');
      } finally {
        open.mockRestore();
      }

      const [event] = await waitForAudits(1);
      expect(event).toMatchObject({
        actorUserId: owner.id,
        conversionRecordId: saved.record.id,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.STORAGE_FAILED,
      });
    });

    it('aborts an incomplete transfer and audits the read failure', async () => {
      const saved = await storeDocument();
      await audits.createQueryBuilder().delete().execute();
      const brokenStream = new PassThrough();
      const open = jest.spyOn(storage, 'openForRead').mockImplementation(() => {
        process.nextTick(() => {
          brokenStream.write(saved.responseBytes.subarray(0, 1));
          brokenStream.destroy(new Error('simulated read failure'));
        });
        return Promise.resolve({
          stream: brokenStream as unknown as ReadStream,
          size: saved.responseBytes.length,
        });
      });

      let transferFailed = false;
      try {
        await request(baseUrl)
          .get(selfPath(saved.record.id))
          .set('Cookie', ownerCookie);
      } catch {
        transferFailed = true;
      } finally {
        open.mockRestore();
      }
      expect(transferFailed).toBe(true);

      const [event] = await waitForAudits(1);
      expect(event).toMatchObject({
        actorUserId: owner.id,
        conversionRecordId: saved.record.id,
        action: TransformationResultAuditAction.DOWNLOAD,
        outcome: TransformationResultAuditOutcome.READ_FAILED,
        fileSizeBytes: null,
      });
    });

    it('does not expose private paths or storage identifiers through HTTP or audit rows', async () => {
      const saved = await storeDocument();

      for (const path of [
        `/assets/${saved.stored.storagePath}`,
        `/assets/conversions/${saved.stored.storagePath}`,
        `/${saved.stored.storagePath}`,
        `/api/convert/files/${saved.stored.id}`,
      ]) {
        await request(baseUrl).get(path).expect(404);
      }

      const history = await request(baseUrl)
        .get('/api/transformations/history')
        .set('Cookie', ownerCookie)
        .expect(200);
      const serialized = JSON.stringify(history.body);
      expect(serialized).not.toContain('storagePath');
      expect(serialized).not.toContain('storedFileId');
      expect(serialized).not.toContain(saved.stored.id);
      expect(serialized).not.toContain(saved.stored.storagePath);

      const eventJson = JSON.stringify(await audits.find());
      expect(eventJson).not.toContain(saved.stored.storagePath);
      expect(eventJson).not.toContain('sample.csv');
      expect(eventJson).not.toContain(readFileSync(FIXTURE, 'utf8'));
    });

    it('audits a rate-limited refusal exactly once', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await request(baseUrl)
          .get(selfPath(UNKNOWN_ID))
          .set('Cookie', ownerCookie)
          .expect(404);
      }
      await request(baseUrl)
        .get(selfPath(UNKNOWN_ID))
        .set('Cookie', ownerCookie)
        .expect(429);

      const events = await waitForAudits(31);
      expect(events).toHaveLength(31);
      expect(
        events.filter(
          (event) =>
            event.outcome === TransformationResultAuditOutcome.RATE_LIMITED,
        ),
      ).toHaveLength(1);
    });
  });

  describe('published OpenAPI contract', () => {
    it('documents both binary routes and retention settings completely', () => {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('contract').setVersion('1').build(),
      );
      const paths = document.paths as Record<
        string,
        {
          get?: {
            responses: Record<
              string,
              {
                content?: Record<string, unknown>;
                headers?: Record<string, unknown>;
              }
            >;
          };
          patch?: { responses: Record<string, unknown> };
        }
      >;

      const self = paths['/api/transformations/history/{itemId}/download'].get!;
      const admin =
        paths['/admin/users/{userId}/transformations/history/{itemId}/download']
          .get!;
      const retention = paths['/admin/settings/transformation-retention'];

      expect(Object.keys(self.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '404',
        '429',
        '500',
      ]);
      expect(Object.keys(admin.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
        '404',
        '429',
        '500',
      ]);
      for (const operation of [self, admin]) {
        expect(Object.keys(operation.responses['200'].content ?? {})).toContain(
          'application/octet-stream',
        );
        expect(
          Object.keys(operation.responses['200'].headers ?? {}).sort(),
        ).toEqual([
          'Cache-Control',
          'Content-Disposition',
          'Content-Encoding',
          'Content-Length',
        ]);
      }
      expect(Object.keys(retention.get!.responses).sort()).toEqual([
        '200',
        '401',
        '403',
      ]);
      expect(Object.keys(retention.patch!.responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '403',
      ]);
    });
  });
});
