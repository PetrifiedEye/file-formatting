import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { ConversionFileStorageService } from '../src/core/storage/conversion-file-storage.service';
import { ConversionRecord } from '../src/modules/conversion/entities/conversion-record.entity';
import { ConversionRetentionService } from '../src/modules/conversion/conversion-retention.service';
import { ConversionStoredFile } from '../src/modules/conversion/entities/conversion-stored-file.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const TEST_PASSWORD = 'CorrectHorse123!';
const FIXTURES = join(__dirname, 'support', 'conversion-fixtures');

const FORMATS = ['csv', 'json', 'xml', 'yaml'] as const;
type Format = (typeof FORMATS)[number];

const MEDIA_TYPES: Record<Format, string> = {
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
};

/** The two records every `sample.*` fixture spells in its own format. */
const RECORDS = [
  { name: 'Ann', age: '30', city: 'Rome' },
  { name: 'Bob', age: '41', city: 'Oslo' },
];

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
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

describe('File Format Conversion (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let userRepository: Repository<User>;
  let recordRepository: Repository<ConversionRecord>;
  let storedFileRepository: Repository<ConversionStoredFile>;
  let retentionService: ConversionRetentionService;
  let storageService: ConversionFileStorageService;
  let userId: string;
  let configService: ConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let cookie: string;
  let userEmail: string;

  const convert = (
    body: Buffer,
    filename: string,
    targetFormat: string,
    // `null` means "send no session". `undefined` would select the default.
    session: string | null = cookie,
    store?: 'true' | 'false',
  ) => {
    const call = request(baseUrl).post('/api/convert');

    if (session) {
      call.set('Cookie', session);
    }

    call.attach('file', body, filename).field('targetFormat', targetFormat);

    if (store !== undefined) {
      call.field('store', store);
    }

    return call;
  };

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
      .register(fastifyCookie, { secret: configService.get('COOKIE_SECRET') });

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

    userRepository = moduleFixture.get(getRepositoryToken(User));
    recordRepository = moduleFixture.get(getRepositoryToken(ConversionRecord));
    storedFileRepository = moduleFixture.get(
      getRepositoryToken(ConversionStoredFile),
    );
    retentionService = moduleFixture.get(ConversionRetentionService);
    storageService = moduleFixture.get(ConversionFileStorageService);
    throttlerStorage = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;

    userEmail = `conversion-${Date.now()}@example.com`;
    const created = await userRepository.save(
      userRepository.create({
        email: userEmail,
        passwordHash: await hashPassword(TEST_PASSWORD),
        status: UserStatus.ACTIVE,
      }),
    );
    userId = created.id;

    const login = await request(baseUrl)
      .post('/auth/login')
      .send({ email: userEmail, password: TEST_PASSWORD });

    cookie = extractSessionCookie(
      login.headers['set-cookie'] as unknown as string[],
    );
  });

  // The route is rate limited on purpose; this suite drives it far harder than
  // any caller would, so the counter is cleared between cases rather than the
  // limit being loosened for tests.
  beforeEach(() => {
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    await storedFileRepository.delete({ userId });
    await recordRepository.delete({ userId });
    await userRepository.delete({ email: userEmail });
    await app.close();
  });

  describe('all twelve directions (FR-002)', () => {
    const directions = FORMATS.flatMap((source) =>
      FORMATS.filter((target) => target !== source).map(
        (target) => [source, target] as const,
      ),
    );

    it('is exactly twelve', () => {
      expect(directions).toHaveLength(12);
    });

    it.each(directions)(
      'converts %s to %s with the documented headers',
      async (source, target) => {
        const response = await convert(
          fixture(`sample.${source}`),
          `sample.${source}`,
          target,
        );

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(
          `${MEDIA_TYPES[target]}; charset=utf-8`,
        );
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="converted.${target}"`,
        );
        expect(response.body.length ?? response.text.length).toBeGreaterThan(0);
      },
    );

    it.each(directions)(
      'carries the same records from %s to %s',
      async (source, target) => {
        const response = await convert(
          fixture(`sample.${source}`),
          `sample.${source}`,
          target,
        );
        const text = response.text ?? response.body.toString('utf8');

        for (const record of RECORDS) {
          expect(text).toContain(record.name);
          expect(text).toContain(record.age);
          expect(text).toContain(record.city);
        }
      },
    );
  });

  describe('round-trip equivalence (SC-001)', () => {
    const roundTrip = async (source: Format, via: Format): Promise<string> => {
      const original = fixture(`sample.${source}`);
      const first = await convert(original, `sample.${source}`, via);
      expect(first.status).toBe(200);

      const back = await convert(
        Buffer.from(first.text, 'utf8'),
        `step.${via}`,
        source,
      );
      expect(back.status).toBe(200);

      return back.text;
    };

    it('CSV to JSON to CSV is exact', async () => {
      await expect(roundTrip('csv', 'json')).resolves.toBe(
        fixture('sample.csv').toString('utf8'),
      );
    });

    it('CSV to YAML to CSV is exact', async () => {
      await expect(roundTrip('csv', 'yaml')).resolves.toBe(
        fixture('sample.csv').toString('utf8'),
      );
    });

    it('JSON to YAML to JSON is exact', async () => {
      await expect(roundTrip('json', 'yaml')).resolves.toBe(
        fixture('sample.json').toString('utf8'),
      );
    });
  });

  describe('encoding (FR-010, FR-020)', () => {
    it('consumes a BOM and never emits one', async () => {
      const response = await convert(fixture('bom.csv'), 'bom.csv', 'json');

      expect(response.status).toBe(200);
      expect(response.text.charCodeAt(0)).not.toBe(0xfeff);
      expect(JSON.parse(response.text)).toEqual([{ name: 'Ann', age: '30' }]);
    });

    it('carries Unicode through unchanged', async () => {
      const response = await convert(
        fixture('unicode.csv'),
        'unicode.csv',
        'json',
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain('café');
      expect(response.text).toContain('日本語');
      expect(response.text).toContain('🇵🇱');
    });
  });

  describe('empty but valid documents', () => {
    it('converts a header-only CSV to an empty array', async () => {
      const response = await convert(
        fixture('header-only.csv'),
        'header-only.csv',
        'json',
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual([]);
    });

    it('converts an empty JSON array to an empty CSV document', async () => {
      const response = await convert(
        fixture('empty-array.json'),
        'empty-array.json',
        'csv',
      );

      expect(response.status).toBe(200);
      expect(response.text).toBe('');
    });

    it('applies the documented ragged-row rules', async () => {
      const response = await convert(
        fixture('ragged.csv'),
        'ragged.csv',
        'json',
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual([
        { name: 'Ann', age: '30' },
        { name: 'Bob', age: '' },
        { name: 'Cid', age: '41', _extra_1: 'extra' },
      ]);
    });
  });

  describe('discovery matches reality (FR-012, SC-010)', () => {
    interface Advertised {
      source: Format;
      mediaType: string;
      extension: string;
      maxInputBytes: number;
      targets: Format[];
    }

    const discover = async (): Promise<Advertised[]> => {
      const response = await request(baseUrl)
        .get('/api/convert/formats')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      return (response.body as { formats: Advertised[] }).formats;
    };

    it('advertises four sources, each with three targets and never itself', async () => {
      const formats = await discover();

      expect(formats.map((entry) => entry.source)).toEqual([
        'csv',
        'json',
        'xml',
        'yaml',
      ]);

      for (const entry of formats) {
        expect(entry.targets).toHaveLength(3);
        expect(entry.targets).not.toContain(entry.source);
        expect(entry.mediaType).toBe(MEDIA_TYPES[entry.source]);
        expect(entry.extension).toBe(entry.source);
        expect(entry.maxInputBytes).toBeGreaterThan(0);
      }
    });

    it('reports each source its own configured limit', async () => {
      const formats = await discover();
      const csv = formats.find((entry) => entry.source === 'csv')!;
      const json = formats.find((entry) => entry.source === 'json')!;

      expect(csv.maxInputBytes).toBe(
        Number(configService.get('CONVERSION_MAX_BYTES_CSV')),
      );
      expect(json.maxInputBytes).toBe(
        Number(configService.get('CONVERSION_MAX_BYTES_JSON')),
      );
    });

    it('accepts every advertised direction', async () => {
      const formats = await discover();

      for (const entry of formats) {
        for (const target of entry.targets) {
          throttlerStorage.storage.clear();

          const response = await convert(
            fixture(`sample.${entry.source}`),
            `sample.${entry.source}`,
            target,
          );

          expect([entry.source, target, response.status]).toEqual([
            entry.source,
            target,
            200,
          ]);
        }
      }
    });

    it('refuses every pair it does not advertise, self-directions included', async () => {
      const formats = await discover();
      const advertised = new Set(
        formats.flatMap((entry) =>
          entry.targets.map((target) => `${entry.source}->${target}`),
        ),
      );

      for (const source of FORMATS) {
        for (const target of [...FORMATS, 'toml']) {
          if (advertised.has(`${source}->${target}`)) {
            continue;
          }

          throttlerStorage.storage.clear();

          const response = await convert(
            fixture(`sample.${source}`),
            `sample.${source}`,
            target,
          );

          expect([source, target, response.status < 400]).toEqual([
            source,
            target,
            false,
          ]);
        }
      }
    });

    it('requires a session', async () => {
      const response = await request(baseUrl).get('/api/convert/formats');

      expect(response.status).toBe(401);
    });
  });

  describe('history (FR-021 – FR-024, SC-004, SC-005)', () => {
    const historyFor = () =>
      recordRepository.find({
        where: { userId },
        order: { startedAt: 'DESC' },
      });

    beforeEach(async () => {
      await recordRepository.delete({ userId });
    });

    it('records a success against the requesting user', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
      );
      expect(response.status).toBe(200);

      const rows = await historyFor();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId,
        originalFileName: 'sample.csv',
        sourceFormat: 'csv',
        targetFormat: 'json',
        outcome: 'success',
        errorCategory: null,
        failureReason: null,
        retentionRequested: false,
        retentionOutcome: 'not_requested',
        storedFileId: null,
      });
      expect(Number(rows[0].inputSizeBytes)).toBe(
        fixture('sample.csv').byteLength,
      );
      expect(rows[0].outputSizeBytes).toBeGreaterThan(0);
      expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(rows[0].startedAt).toBeInstanceOf(Date);
    });

    it('records a failure, with its category', async () => {
      const response = await convert(fixture('xxe.xml'), 'xxe.xml', 'json');
      expect(response.status).toBe(400);

      const rows = await historyFor();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId,
        outcome: 'failure',
        errorCategory: 'parse_error',
        failureReason: 'xml_doctype_forbidden',
        outputSizeBytes: null,
      });
    });

    it('records exactly one row per attempt', async () => {
      await convert(fixture('sample.csv'), 'sample.csv', 'json');
      throttlerStorage.storage.clear();
      await convert(fixture('xxe.xml'), 'xxe.xml', 'json');

      const rows = await historyFor();

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.outcome).sort()).toEqual([
        'failure',
        'success',
      ]);
    });

    it('records the bytes read even when the attempt is refused', async () => {
      // A row saying 0 bytes for a file we plainly read would be wrong; the
      // size is taken from the reader, not from a result that never existed.
      await convert(fixture('blob.png'), 'blob.png', 'json');

      const rows = await historyFor();

      expect(Number(rows[0].inputSizeBytes)).toBe(
        fixture('blob.png').byteLength,
      );
    });

    it('records what the caller asked for when store arrives first', async () => {
      const response = await request(baseUrl)
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('store', 'true')
        .field('targetFormat', 'json')
        .attach('file', fixture('blob.png'), 'blob.png');

      expect(response.status).toBe(415);

      const rows = await historyFor();

      expect(rows[0]).toMatchObject({
        outcome: 'failure',
        retentionRequested: true,
        retentionOutcome: 'failed',
      });
    });

    it.each([
      ['a zero-byte file', 'empty.csv', 'json', 'bad_request'],
      ['an undetectable blob', 'blob.png', 'json', 'unsupported_media_type'],
      ['invalid UTF-8', 'invalid-utf8.csv', 'json', 'parse_error'],
      ['a too-deep document', 'deep.json', 'yaml', 'structure_limit_exceeded'],
      ['an oversized file', 'oversized.csv', 'json', 'payload_too_large'],
    ])(
      'records %s under its own category',
      async (_label, name, target, category) => {
        const response = await convert(fixture(name), name, target);
        expect(response.status).toBeGreaterThanOrEqual(400);

        const rows = await historyFor();

        expect(rows).toHaveLength(1);
        expect(rows[0].errorCategory).toBe(category);
      },
    );

    it('records an unauthenticated attempt nowhere', async () => {
      // There is no user to attribute it to, and the guard rejects before any
      // file is read. JwtAuthGuard's own audit trail covers it.
      await convert(fixture('sample.csv'), 'sample.csv', 'json', null);

      await expect(historyFor()).resolves.toHaveLength(0);
    });

    it('holds no fragment of the uploaded file in any column (SC-005)', async () => {
      // A file whose contents would be unmistakable if they leaked.
      const secret = Buffer.from(
        'name,ssn,salary\r\nAnn,123-45-6789,250000\r\n"unterminated',
        'utf8',
      );

      await convert(secret, 'payroll.csv', 'json');

      const rows = await historyFor();
      const serialized = JSON.stringify(rows);

      expect(rows).toHaveLength(1);
      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain('250000');
      expect(serialized).not.toContain('unterminated');
      // The file *name* is kept on purpose; the contents are not.
      expect(rows[0].originalFileName).toBe('payroll.csv');
    });
  });

  describe('optional retention (FR-025 – FR-028)', () => {
    beforeEach(async () => {
      await recordRepository.delete({ userId });
    });

    afterAll(async () => {
      await rm(storageService.root(), { recursive: true, force: true });
    });

    const storedFilesFor = () =>
      storedFileRepository.find({ where: { userId } });

    it('stores the result and links it when store=true', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        cookie,
        'true',
      );

      expect(response.status).toBe(200);
      expect(response.headers['x-conversion-retention']).toBe('stored');

      const files = await storedFilesFor();
      const rows = await recordRepository.find({ where: { userId } });

      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        userId,
        format: 'json',
        conversionRecordId: rows[0].id,
      });
      expect(rows[0]).toMatchObject({
        retentionRequested: true,
        retentionOutcome: 'stored',
        storedFileId: files[0].id,
      });

      // The bytes on disk are the bytes the caller received.
      await expect(
        readFile(join(storageService.root(), files[0].storagePath), 'utf8'),
      ).resolves.toBe(response.text);
    });

    it('stores nothing when store is absent, with byte-identical output', async () => {
      const withStore = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        cookie,
        'true',
      );
      const storedPath = (await storedFilesFor())[0].storagePath;

      await storedFileRepository.delete({ userId });
      await recordRepository.delete({ userId });
      throttlerStorage.storage.clear();

      const without = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
      );

      expect(without.status).toBe(200);
      expect(without.headers['x-conversion-retention']).toBe('not-requested');
      expect(without.text).toBe(withStore.text);
      await expect(storedFilesFor()).resolves.toHaveLength(0);

      const rows = await recordRepository.find({ where: { userId } });
      expect(rows[0]).toMatchObject({
        retentionRequested: false,
        retentionOutcome: 'not_requested',
        storedFileId: null,
      });
      expect(storedPath).toBeDefined();
    });

    it('stores nothing for a conversion that failed (FR-026)', async () => {
      const response = await convert(
        fixture('xxe.xml'),
        'xxe.xml',
        'json',
        cookie,
        'true',
      );

      expect(response.status).toBe(400);
      await expect(storedFilesFor()).resolves.toHaveLength(0);

      const rows = await recordRepository.find({ where: { userId } });
      expect(rows[0]).toMatchObject({
        outcome: 'failure',
        retentionRequested: true,
        retentionOutcome: 'failed',
        storedFileId: null,
      });
    });

    it('still returns 200 with the file when storing fails (FR-028)', async () => {
      const store = jest
        .spyOn(retentionService, 'store')
        .mockResolvedValue(null);

      try {
        const response = await convert(
          fixture('sample.csv'),
          'sample.csv',
          'json',
          cookie,
          'true',
        );

        expect(response.status).toBe(200);
        expect(response.headers['x-conversion-retention']).toBe('failed');
        expect(JSON.parse(response.text)).toHaveLength(2);

        await expect(storedFilesFor()).resolves.toHaveLength(0);

        const rows = await recordRepository.find({ where: { userId } });
        expect(rows[0]).toMatchObject({
          outcome: 'success',
          retentionRequested: true,
          retentionOutcome: 'failed',
          storedFileId: null,
        });
      } finally {
        store.mockRestore();
      }
    });

    it('keeps the retained file out of the unauthenticated assets tree (FR-027)', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        cookie,
        'true',
      );
      expect(response.status).toBe(200);

      const [file] = await storedFilesFor();

      // The storage root is not inside ASSETS_DIR...
      expect(storageService.isInsideAssetsDir()).toBe(false);

      // ...and the path is not reachable under /assets/ either way.
      const served = await request(baseUrl).get(`/assets/${file.storagePath}`);
      expect(served.status).toBe(404);

      // Nothing in this feature serves them at all.
      const direct = await request(baseUrl)
        .get(`/api/convert/files/${file.id}`)
        .set('Cookie', cookie);
      expect(direct.status).toBe(404);
    });

    it('refuses a malformed store flag', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        cookie,
        'yes' as 'true',
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_store_flag');
    });
  });

  describe('the refusal matrix (US5)', () => {
    it('refuses an unauthenticated conversion before reading anything', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        null,
      );

      expect(response.status).toBe(401);
    });

    it.each([
      ['a zero-byte file', 'empty.csv', 'json', 400, 'empty_file'],
      ['invalid UTF-8', 'invalid-utf8.csv', 'json', 400, 'invalid_encoding'],
      ['malformed input', 'malformed.xml', 'json', 400, 'parse_error'],
      [
        'converting a format to itself',
        'sample.csv',
        'csv',
        400,
        'same_format',
      ],
      [
        'a blob matching no format',
        'blob.png',
        'json',
        415,
        'unsupported_source_format',
      ],
    ])(
      // Placeholders bind to the tuple in order, so the status is the fourth.
      // With three of them, `%i` landed on the file name and printed NaN.
      'refuses %s (%s -> %s) with %i %s',
      async (_label, name, target, status, code) => {
        const body =
          name === 'malformed.xml'
            ? Buffer.from('<a><b>unclosed</a>', 'utf8')
            : fixture(name);

        const response = await convert(body, name, target);

        expect([code, response.status]).toEqual([code, status]);
        expect(response.body.code).toBe(code);
      },
    );

    it('refuses an unknown target format with 415', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'toml',
      );

      expect(response.status).toBe(415);
      expect(response.body.code).toBe('unsupported_target_format');
    });

    it('refuses a missing target format with 400', async () => {
      const response = await request(baseUrl)
        .post('/api/convert')
        .set('Cookie', cookie)
        .attach('file', fixture('sample.csv'), 'sample.csv');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_target_format');
    });

    it('refuses a request with no file part', async () => {
      const response = await request(baseUrl)
        .post('/api/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_file');
    });

    it('refuses an unexpected extra part', async () => {
      const response = await request(baseUrl)
        .post('/api/convert')
        .set('Cookie', cookie)
        .attach('file', fixture('sample.csv'), 'sample.csv')
        .field('targetFormat', 'json')
        .field('colour', 'red');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('unexpected_part');
    });

    it('refuses a malformed store flag', async () => {
      const response = await convert(
        fixture('sample.csv'),
        'sample.csv',
        'json',
        cookie,
        'yes' as 'true',
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_store_flag');
    });

    describe('per-format size limits (FR-016, US5 scenario 3)', () => {
      it('refuses a CSV over its own limit, naming that limit', async () => {
        const response = await convert(
          fixture('oversized.csv'),
          'oversized.csv',
          'json',
        );

        expect(response.status).toBe(413);
        expect(response.body.code).toBe('input_too_large');
        expect(response.body.message).toContain(
          configService.get('CONVERSION_MAX_BYTES_CSV'),
        );
      });

      it('accepts the same byte count as JSON', async () => {
        // The CSV ceiling is configured well below the JSON one, so this is
        // the same request weighed on a different scale.
        const csvLimit = Number(configService.get('CONVERSION_MAX_BYTES_CSV'));
        const rows = Array.from({ length: 800 }, (_, i) => ({
          name: `user${i}`,
          age: String((i % 90) + 10),
        }));
        const json = Buffer.from(JSON.stringify(rows), 'utf8');

        expect(json.byteLength).toBeGreaterThan(csvLimit);
        expect(fixture('oversized.csv').byteLength).toBeGreaterThan(csvLimit);

        const response = await convert(json, 'big.json', 'yaml');

        expect(response.status).toBe(200);
      });

      it('records the bytes it actually read for an oversized file', async () => {
        // SC-006: the stream is destroyed once the budget is passed, so the
        // row holds the point at which that happened — more than nothing, and
        // less than the file's true size. The fixture is deliberately larger
        // than the 64 KiB detection prefix; a smaller one would be read in
        // full before any per-format budget could apply.
        await recordRepository.delete({ userId });

        const full = fixture('oversized.csv').byteLength;
        const limit = Number(configService.get('CONVERSION_MAX_BYTES_CSV'));

        await convert(fixture('oversized.csv'), 'oversized.csv', 'json');

        const [row] = await recordRepository.find({ where: { userId } });
        const recorded = Number(row.inputSizeBytes);

        expect(recorded).toBeGreaterThan(limit);
        expect(recorded).toBeLessThan(full);
      });
    });

    it('refuses past the rate limit with 429 (FR-015)', async () => {
      // The route allows 10 per minute; the eleventh is refused.
      const statuses: number[] = [];

      for (let i = 0; i < 12; i += 1) {
        const response = await convert(
          fixture('sample.csv'),
          'sample.csv',
          'json',
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(
        true,
      );
      expect(statuses).toContain(429);
    });
  });

  describe('safety refusals (FR-017, FR-018, SC-007)', () => {
    it('refuses a DOCTYPE declaration without echoing what it referenced', async () => {
      const response = await convert(fixture('xxe.xml'), 'xxe.xml', 'json');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('xml_doctype_forbidden');

      // SC-007: nothing about the referenced file comes back.
      const body = JSON.stringify(response.body);
      expect(body).not.toContain('passwd');
      expect(body).not.toContain('file://');
      expect(body).not.toContain('xxe');
    });

    it('refuses a document past the depth limit', async () => {
      const response = await convert(fixture('deep.json'), 'deep.json', 'yaml');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('structure_limit_exceeded');
    });

    it('refuses an alias bomb promptly', async () => {
      const started = Date.now();

      const response = await convert(
        fixture('alias-bomb.yaml'),
        'alias-bomb.yaml',
        'json',
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });
});
