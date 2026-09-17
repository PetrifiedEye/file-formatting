import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createServer, Server } from 'net';
import { readFileSync } from 'fs';
import { access, readdir, rm } from 'fs/promises';
import { join, resolve } from 'path';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { ConfigService } from '../src/core/config/config.service';
import { ConversionRecord } from '../src/modules/conversion/entities/conversion-record.entity';
import { ConversionRetentionService } from '../src/modules/conversion/conversion-retention.service';
import { ConversionStoredFile } from '../src/modules/conversion/entities/conversion-stored-file.entity';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';

const TEST_PASSWORD = 'CorrectHorse123!';
const FIXTURES = join(__dirname, 'support', 'image-fixtures');

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

/**
 * A socket nothing should ever connect to.
 *
 * SC-006 asks for an *observation*, not an assertion about the code: the
 * attack corpus points at 127.0.0.1:9 and this listens there, so a renderer or
 * a parser that resolved any of those references would leave a connection
 * behind. Zero connections over a suite that submits every one of them is the
 * evidence.
 */
class EgressWatcher {
  private readonly server: Server;
  private connections = 0;

  constructor() {
    this.server = createServer((socket) => {
      this.connections += 1;
      socket.destroy();
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  get observed(): number {
    return this.connections;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('Image Conversion (e2e)', () => {
  let app: INestApplication<App>;
  let userRepository: Repository<User>;
  let recordRepository: Repository<ConversionRecord>;
  let storedFileRepository: Repository<ConversionStoredFile>;
  let retentionService: ConversionRetentionService;
  let configService: ConfigService;
  let throttlerStorage: ThrottlerStorageService;
  let userId: string;
  let userEmail: string;
  let cookie: string;
  let egress: EgressWatcher;

  const convert = (
    body: Buffer,
    filename: string,
    targetFormat: string,
    // `null` means "send no session". `undefined` would select the default.
    session: string | null = cookie,
    store?: 'true' | 'false',
  ) => {
    const call = request(app.getHttpServer()).post('/api/images/convert');

    if (session) {
      call.set('Cookie', session);
    }

    call.attach('file', body, filename);

    if (targetFormat !== '') {
      call.field('targetFormat', targetFormat);
    }

    if (store !== undefined) {
      call.field('store', store);
    }

    return call;
  };

  const latestRecord = async (): Promise<ConversionRecord | null> =>
    recordRepository.findOne({
      where: { userId },
      order: { startedAt: 'DESC', createdAt: 'DESC' },
    });

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    // Listening before the app starts, so every request in this file is made
    // while an unexpected outbound connection would be recorded.
    egress = new EgressWatcher();
    await egress.listen(9099);

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
    await app.getHttpAdapter().getInstance().ready();

    userRepository = moduleFixture.get(getRepositoryToken(User));
    recordRepository = moduleFixture.get(getRepositoryToken(ConversionRecord));
    storedFileRepository = moduleFixture.get(
      getRepositoryToken(ConversionStoredFile),
    );
    retentionService = moduleFixture.get(ConversionRetentionService);
    throttlerStorage = moduleFixture.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;

    userEmail = `image-conversion-${Date.now()}@example.com`;
    const created = await userRepository.save(
      userRepository.create({
        email: userEmail,
        passwordHash: await hashPassword(TEST_PASSWORD),
        status: UserStatus.ACTIVE,
      }),
    );
    userId = created.id;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: userEmail, password: TEST_PASSWORD });

    cookie = extractSessionCookie(
      login.headers['set-cookie'] as unknown as string[],
    );
  });

  // The route is rate limited to 5/minute on purpose; this suite drives it far
  // harder than any caller would, so the counter is cleared between cases
  // rather than the limit being loosened for tests.
  beforeEach(() => {
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
  });

  afterAll(async () => {
    const stored = await storedFileRepository.find({ where: { userId } });

    for (const file of stored) {
      await rm(
        join(
          resolve(configService.get('CONVERSION_STORAGE_DIR')),
          file.storagePath,
        ),
        {
          force: true,
        },
      );
    }

    await storedFileRepository.delete({ userId });
    await recordRepository.delete({ userId });
    await userRepository.delete({ email: userEmail });
    await app.close();
    await egress.close();
  });

  describe('raster conversion (US1)', () => {
    it.each([
      ['png', 'jpeg', 'solid.png', 'image/jpeg', 'jpg'],
      ['jpeg', 'png', 'solid.jpg', 'image/png', 'png'],
    ])(
      'converts %s to %s with the documented headers',
      async (_source, target, file, mediaType, extension) => {
        const response = await convert(fixture(file), file, target);

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(mediaType);
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="converted.${extension}"`,
        );
        expect(response.headers['x-image-conversion-retention']).toBe(
          'not-requested',
        );

        const metadata = await sharp(response.body as Buffer).metadata();

        expect(metadata.format).toBe(target);
      },
    );

    /** SC-002: exactly, in both directions. */
    it.each([
      ['solid.png', 'jpeg'],
      ['solid.jpg', 'png'],
      ['greyscale.png', 'jpeg'],
      ['indexed.png', 'jpeg'],
      ['sixteen-bit.png', 'jpeg'],
    ])(
      'preserves the dimensions of %s converted to %s',
      async (file, target) => {
        const source = await sharp(fixture(file)).metadata();
        const response = await convert(fixture(file), file, target);

        expect(response.status).toBe(200);

        const converted = await sharp(response.body as Buffer).metadata();

        expect(converted.width).toBe(source.width);
        expect(converted.height).toBe(source.height);
      },
    );

    /**
     * The post-orientation reading of "the source image's pixel dimensions":
     * the file stores 48x64 with orientation 6, and a viewer shows 64x48.
     */
    it('preserves the dimensions a viewer shows for a rotated JPEG', async () => {
      const response = await convert(
        fixture('exif-rotated.jpg'),
        'exif-rotated.jpg',
        'png',
      );

      expect(response.status).toBe(200);

      const converted = await sharp(response.body as Buffer).metadata();

      expect(converted.width).toBe(64);
      expect(converted.height).toBe(48);
      expect(converted.orientation).toBeUndefined();
    });

    /** SC-003, pixel by pixel. */
    it('composites a transparent PNG onto the configured background', async () => {
      const background = configService.get('IMAGE_BACKGROUND_COLOR');

      expect(background).toBe('#ffffff');

      const response = await convert(
        fixture('fully-transparent.png'),
        'fully-transparent.png',
        'jpeg',
      );

      expect(response.status).toBe(200);

      const { data, info } = await sharp(response.body as Buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });

      expect(info.channels).toBe(3);

      for (let index = 0; index < data.length; index += 1) {
        // Fully transparent everywhere, so the result is the background
        // throughout. JPEG is lossy, hence the tolerance.
        expect(data[index]).toBeGreaterThan(245);
      }
    });

    it('carries no metadata into the result', async () => {
      const response = await convert(
        fixture('exif-rotated.jpg'),
        'exif-rotated.jpg',
        'png',
      );
      const metadata = await sharp(response.body as Buffer).metadata();

      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    });

    it('converts a file whose name disagrees with its content', async () => {
      const response = await convert(
        fixture('jpeg-bytes-named.png'),
        'holiday.png',
        'png',
      );

      expect(response.status).toBe(200);
      expect((await latestRecord())?.sourceFormat).toBe('jpeg');
    });
  });

  describe('SVG rasterisation (US2)', () => {
    it.each([
      ['png', 'image/png', 'png'],
      ['jpeg', 'image/jpeg', 'jpg'],
    ])(
      'renders an SVG to %s at its declared size',
      async (target, mediaType, extension) => {
        const response = await convert(
          fixture('valid-declared.svg'),
          'valid-declared.svg',
          target,
        );

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(mediaType);
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="converted.${extension}"`,
        );

        const metadata = await sharp(response.body as Buffer).metadata();

        expect(metadata.format).toBe(target);
        expect(metadata.width).toBe(120);
        expect(metadata.height).toBe(80);
      },
    );

    it.each([
      ['valid-viewbox-only.svg', 300, 150],
      ['valid-width-only.svg', 200, 150],
      ['valid-inches.svg', 96, 48],
      ['fractional.svg', 11, 11],
    ])('sizes %s as %ix%i', async (file, width, height) => {
      const response = await convert(fixture(file), file, 'png');

      expect(response.status).toBe(200);

      const metadata = await sharp(response.body as Buffer).metadata();

      expect(metadata.width).toBe(width);
      expect(metadata.height).toBe(height);
    });

    it('refuses an SVG whose size cannot be determined', async () => {
      const response = await convert(
        fixture('no-size.svg'),
        'no-size.svg',
        'png',
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('svg_no_intrinsic_size');
    });

    it('refuses an SVG larger than the configured maximum', async () => {
      const response = await convert(
        fixture('enormous.svg'),
        'enormous.svg',
        'png',
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('image_dimensions_exceeded');
      expect(response.body.message).toContain('99999');
    });

    it('allows fragment references and inline data URIs', async () => {
      for (const file of [
        'valid-fragment-reference.svg',
        'valid-data-uri.svg',
      ]) {
        const response = await convert(fixture(file), file, 'png');

        expect(response.status).toBe(200);
      }
    });
  });

  describe('unsafe uploads (US3)', () => {
    it.each([
      ['scripted.svg', 'svg_active_content'],
      ['onload.svg', 'svg_active_content'],
      ['javascript-href.svg', 'svg_active_content'],
      ['foreign-object.svg', 'svg_active_content'],
      ['xxe.svg', 'xml_doctype_forbidden'],
      ['billion-laughs.svg', 'xml_doctype_forbidden'],
      ['remote-image.svg', 'svg_external_reference'],
      ['import-stylesheet.svg', 'svg_external_reference'],
      ['remote-style-url.svg', 'svg_external_reference'],
      ['relative-reference.svg', 'svg_external_reference'],
    ])('refuses %s as %s', async (file, code) => {
      const response = await convert(fixture(file), file, 'png');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe(code);
      // No part of the document reaches the caller.
      expect(JSON.stringify(response.body)).not.toContain('etc/passwd');
      expect(JSON.stringify(response.body)).not.toContain('alert');
    });

    /**
     * SC-006. Every corpus file above references 127.0.0.1:9099, and nothing
     * connected to it — the module has no HTTP client and reads no file the
     * document names, and the renderer is never reached for a refused
     * document anyway.
     */
    it('makes no outbound connection while processing any of them', () => {
      expect(egress.observed).toBe(0);
    });

    /**
     * SC-007. The file is 229 bytes and its header declares 900 megapixels.
     * Refused from the header, so nothing is allocated — a reader that
     * trusted the declaration and allocated would need 3.6 GB.
     */
    it('refuses a decompression bomb without allocating for it', async () => {
      const bomb = fixture('pixel-bomb.png');

      expect(bomb.length).toBeLessThan(100 * 1024);

      global.gc?.();
      const before = process.memoryUsage().heapUsed;

      const response = await convert(bomb, 'pixel-bomb.png', 'jpeg');

      global.gc?.();
      const after = process.memoryUsage().heapUsed;

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('image_pixel_budget_exceeded');
      // 900 MP would be 3.6 GB; anything under 100 MB proves no pixel buffer
      // was allocated for it.
      expect(after - before).toBeLessThan(100 * 1024 * 1024);
    });

    /**
     * SC-008: refused the moment the budget is passed, without the whole body
     * being read. The recorded input size is where the budget was hit, which
     * is strictly less than what was sent.
     */
    it.each([
      ['png', 'solid.png'],
      ['jpeg', 'solid.jpg'],
      ['svg', 'valid-declared.svg'],
    ])(
      'refuses an oversized %s before reading it all',
      async (format, seed) => {
        const limit = Number(
          configService.get(`IMAGE_MAX_BYTES_${format.toUpperCase()}` as never),
        );
        // Comfortably over, not marginally: a file that passes the budget
        // only in its final chunk would be fully read whatever the reader
        // did, so it could not distinguish "stopped early" from "read it all
        // and then measured".
        const oversized = Buffer.concat([
          fixture(seed),
          Buffer.alloc(limit + 512 * 1024, 0x41),
        ]);

        const response = await convert(oversized, seed, 'png');

        expect(response.status).toBe(413);
        expect(response.body.code).toBe('input_too_large');

        const record = await latestRecord();

        expect(Number(record?.inputSizeBytes)).toBeLessThan(oversized.length);
        // The format was determinable from the prefix, so the row says what
        // the file was rather than leaving it unknown.
        expect(record?.sourceFormat).toBe(format);
      },
    );

    /**
     * US3.4: the limit that applies is the *detected* source format's, so the
     * same byte count is accepted as PNG and refused as SVG.
     */
    it('applies a different limit to the same byte count by format', async () => {
      const svgLimit = Number(configService.get('IMAGE_MAX_BYTES_SVG'));
      const pngLimit = Number(configService.get('IMAGE_MAX_BYTES_PNG'));

      expect(svgLimit).toBeLessThan(pngLimit);

      const size = svgLimit + 4096;
      const asPng = Buffer.concat([
        fixture('solid.png'),
        Buffer.alloc(size, 0x41),
      ]);
      const asSvg = Buffer.concat([
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!--',
        ),
        Buffer.alloc(size, 0x41),
        Buffer.from('--></svg>'),
      ]);

      expect((await convert(asPng, 'a.png', 'jpeg')).status).toBe(200);

      const refused = await convert(asSvg, 'a.svg', 'png');

      expect(refused.status).toBe(413);
      expect(refused.body.code).toBe('input_too_large');
    });
  });

  describe('discovery (US4)', () => {
    const formats = (session: string | null = cookie) => {
      const call = request(app.getHttpServer()).get(
        '/api/images/convert/formats',
      );

      if (session) {
        call.set('Cookie', session);
      }

      return call;
    };

    it('returns the exact documented shape, in stable order', async () => {
      const response = await formats();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        formats: [
          {
            source: 'jpeg',
            mediaType: 'image/jpeg',
            extension: 'jpg',
            maxInputBytes: Number(configService.get('IMAGE_MAX_BYTES_JPEG')),
            targets: ['png'],
          },
          {
            source: 'png',
            mediaType: 'image/png',
            extension: 'png',
            maxInputBytes: Number(configService.get('IMAGE_MAX_BYTES_PNG')),
            targets: ['jpeg'],
          },
          {
            source: 'svg',
            mediaType: 'image/svg+xml',
            extension: 'svg',
            maxInputBytes: Number(configService.get('IMAGE_MAX_BYTES_SVG')),
            targets: ['jpeg', 'png'],
          },
        ],
      });
    });

    it('never advertises svg as a target', async () => {
      for (const entry of (await formats()).body.formats) {
        expect(entry.targets).not.toContain('svg');
      }
    });

    it('requires a session', async () => {
      expect((await formats(null)).status).toBe(401);
    });

    /**
     * SC-010, mechanically: read the endpoint, drive every advertised pair to
     * success, and check every unadvertised pair is refused. Discovery and
     * enforcement are one computation, and this is the proof rather than the
     * claim.
     */
    it('accepts exactly the pairs it advertises', async () => {
      const seeds: Record<string, string> = {
        png: 'solid.png',
        jpeg: 'solid.jpg',
        svg: 'valid-declared.svg',
      };

      const advertised = new Set<string>();
      const body = (await formats()).body as {
        formats: { source: string; targets: string[] }[];
      };

      for (const entry of body.formats) {
        for (const target of entry.targets) {
          advertised.add(`${entry.source}->${target}`);
        }
      }

      expect(advertised.size).toBe(4);

      for (const source of Object.keys(seeds)) {
        for (const target of Object.keys(seeds)) {
          throttlerStorage.storage.clear();

          const response = await convert(
            fixture(seeds[source]),
            seeds[source],
            target,
          );

          if (advertised.has(`${source}->${target}`)) {
            expect([source, target, response.status]).toEqual([
              source,
              target,
              200,
            ]);
          } else {
            expect([source, target, response.status >= 400]).toEqual([
              source,
              target,
              true,
            ]);
          }
        }
      }
    });
  });

  describe('the refusal matrix (US5)', () => {
    it('refuses a request with no session, and records nothing', async () => {
      const before = await recordRepository.count({ where: { userId } });
      const response = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        null,
      );

      expect(response.status).toBe(401);
      expect(await recordRepository.count({ where: { userId } })).toBe(before);
    });

    it.each([
      ['a zero-byte file', 'empty.png', 'jpeg', 400, 'empty_file'],
      [
        'a file matching no format',
        'not-an-image.png',
        'jpeg',
        415,
        'unsupported_source_format',
      ],
      [
        'a corrupt file of a known format',
        'truncated.png',
        'jpeg',
        400,
        'image_invalid',
      ],
      [
        'a raster source asking for svg',
        'solid.png',
        'svg',
        415,
        'image_vectorisation_unsupported',
      ],
      ['a target equal to the source', 'solid.png', 'png', 400, 'same_format'],
      [
        'an unrecognised target',
        'solid.png',
        'tiff',
        415,
        'unsupported_target_format',
      ],
    ])('refuses %s', async (_name, file, target, status, code) => {
      const response = await convert(fixture(file), file, target);

      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    });

    it('refuses a request with no targetFormat', async () => {
      const response = await convert(fixture('solid.png'), 'solid.png', '');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_target_format');
    });

    it('refuses a non-boolean store flag', async () => {
      const response = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        cookie,
        'yes' as 'true',
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_store_flag');
    });

    it('refuses an unexpected part', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/images/convert')
        .set('Cookie', cookie)
        .attach('file', fixture('solid.png'), 'solid.png')
        .field('targetFormat', 'jpeg')
        .field('quality', '100');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('unexpected_part');
    });

    it('refuses a request with no file part', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/images/convert')
        .set('Cookie', cookie)
        .field('targetFormat', 'jpeg');

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('missing_file');
    });

    /**
     * The documented, inherited consequence: the file must be refused while
     * the stream is still open, and `targetFormat` may legitimately arrive
     * after it, so no ordering makes both refusals take precedence.
     */
    it('answers 413, not 400, when a request is both oversized and missing targetFormat', async () => {
      const limit = Number(configService.get('IMAGE_MAX_BYTES_PNG'));
      const oversized = Buffer.concat([
        fixture('solid.png'),
        Buffer.alloc(limit + 1024, 0x41),
      ]);

      const response = await convert(oversized, 'big.png', '');

      expect(response.status).toBe(413);
      expect(response.body.code).toBe('input_too_large');
    });

    it('rate limits the conversion route more tightly than the text one', async () => {
      const responses: number[] = [];

      for (let attempt = 0; attempt < 7; attempt += 1) {
        responses.push(
          (await convert(fixture('solid.png'), 'solid.png', 'jpeg')).status,
        );
      }

      expect(responses.filter((status) => status === 200)).toHaveLength(5);
      expect(responses.filter((status) => status === 429).length).toBe(2);
    });
  });

  describe('retention (US6)', () => {
    it('keeps nothing when it was not requested', async () => {
      const response = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        cookie,
        'false',
      );

      expect(response.status).toBe(200);
      expect(response.headers['x-image-conversion-retention']).toBe(
        'not-requested',
      );

      const record = await latestRecord();

      expect(record?.retentionRequested).toBe(false);
      expect(record?.retentionOutcome).toBe('not_requested');
      expect(record?.storedFileId).toBeNull();
    });

    it('keeps the result when asked, and links it to the attempt', async () => {
      const response = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        cookie,
        'true',
      );

      expect(response.status).toBe(200);
      expect(response.headers['x-image-conversion-retention']).toBe('stored');

      const record = await latestRecord();

      expect(record?.retentionOutcome).toBe('stored');
      expect(record?.storedFileId).not.toBeNull();

      const stored = await storedFileRepository.findOne({
        where: { id: record!.storedFileId! },
      });

      expect(stored?.format).toBe('jpeg');
      expect(stored?.sizeBytes).toBe((response.body as Buffer).length);
    });

    /**
     * FR-030: under `CONVERSION_STORAGE_DIR` as `<userId>/<id>.<ext>`, which
     * sits outside the statically served `ASSETS_DIR` — so the file exists on
     * disk and is unreachable over HTTP.
     */
    it('writes it outside the statically served tree and serves it to nobody', async () => {
      await convert(fixture('solid.png'), 'solid.png', 'jpeg', cookie, 'true');

      const record = await latestRecord();
      const stored = await storedFileRepository.findOne({
        where: { id: record!.storedFileId! },
      });

      expect(stored!.storagePath).toBe(`${userId}/${stored!.id}.jpg`);

      const storageRoot = resolve(configService.get('CONVERSION_STORAGE_DIR'));
      const assetsRoot = resolve(configService.get('ASSETS_DIR'));

      expect(storageRoot.startsWith(assetsRoot)).toBe(false);
      await expect(
        access(join(storageRoot, stored!.storagePath)),
      ).resolves.toBeUndefined();

      for (const path of [
        `/assets/${stored!.storagePath}`,
        `/assets/conversions/${stored!.storagePath}`,
        `/${stored!.storagePath}`,
      ]) {
        const reachable = await request(app.getHttpServer())
          .get(path)
          .set('Cookie', cookie);

        expect(reachable.status).toBeGreaterThanOrEqual(400);
      }
    });

    /** FR-031: a storage failure never changes the status the caller gets. */
    it('returns a valid image when storage fails, and says so in the header', async () => {
      const store = jest
        .spyOn(retentionService, 'store')
        .mockResolvedValue(null);

      try {
        const response = await convert(
          fixture('solid.png'),
          'solid.png',
          'jpeg',
          cookie,
          'true',
        );

        expect(response.status).toBe(200);
        expect(response.headers['x-image-conversion-retention']).toBe('failed');

        const metadata = await sharp(response.body as Buffer).metadata();

        expect(metadata.format).toBe('jpeg');
        expect((await latestRecord())?.retentionOutcome).toBe('failed');
      } finally {
        store.mockRestore();
      }
    });

    /** FR-029: nothing is kept for an attempt that did not complete. */
    it('leaves nothing on disk when the conversion fails', async () => {
      const storageRoot = resolve(configService.get('CONVERSION_STORAGE_DIR'));
      const before = await readdir(join(storageRoot, userId)).catch(() => []);

      const response = await convert(
        fixture('truncated.png'),
        'truncated.png',
        'jpeg',
        cookie,
        'true',
      );

      expect(response.status).toBe(400);

      const after = await readdir(join(storageRoot, userId)).catch(() => []);

      expect(after).toEqual(before);
      expect((await latestRecord())?.retentionOutcome).toBe('failed');
    });

    it('produces identical bytes whether or not the result is kept', async () => {
      const kept = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        cookie,
        'true',
      );
      const notKept = await convert(
        fixture('solid.png'),
        'solid.png',
        'jpeg',
        cookie,
        'false',
      );

      expect(kept.body).toEqual(notKept.body);
    });
  });

  describe('history and what it may contain (SC-011, SC-012)', () => {
    it('records every authenticated attempt, successful or not', async () => {
      const before = await recordRepository.count({ where: { userId } });

      await convert(fixture('solid.png'), 'solid.png', 'jpeg');
      await convert(fixture('truncated.png'), 'truncated.png', 'jpeg');
      await convert(fixture('scripted.svg'), 'scripted.svg', 'png');

      expect(await recordRepository.count({ where: { userId } })).toBe(
        before + 3,
      );
    });

    it('records the direction, the outcome, and a duration', async () => {
      await convert(fixture('solid.png'), 'solid.png', 'jpeg');

      const record = await latestRecord();

      expect(record).toMatchObject({
        sourceFormat: 'png',
        targetFormat: 'jpeg',
        outcome: 'success',
        errorCategory: null,
        failureReason: null,
      });
      expect(record!.durationMs).toBeGreaterThanOrEqual(0);
      expect(record!.outputSizeBytes).toBeGreaterThan(0);
    });

    it('records a failure as a fixed code and a category', async () => {
      await convert(fixture('scripted.svg'), 'scripted.svg', 'png');

      expect(await latestRecord()).toMatchObject({
        outcome: 'failure',
        errorCategory: 'bad_request',
        failureReason: 'svg_active_content',
        outputSizeBytes: null,
      });
    });

    /**
     * SC-012, swept across every path this suite exercises: no column of any
     * row written for this user holds bytes from an uploaded or produced
     * image. The guarantee is structural — the table has no column capable of
     * it — and this is the check that nothing has quietly added one.
     */
    it('holds no image content in any column, on any path', async () => {
      const marker = 'SECRET-PIXELS';
      const tagged = Buffer.concat([fixture('solid.png'), Buffer.from(marker)]);

      await convert(tagged, `${marker}.png`, 'jpeg');
      await convert(fixture('scripted.svg'), `${marker}.svg`, 'png');
      await convert(fixture('truncated.png'), `${marker}.png`, 'jpeg');

      const records = await recordRepository.find({ where: { userId } });

      expect(records.length).toBeGreaterThan(0);

      for (const record of records) {
        for (const [column, value] of Object.entries(record)) {
          if (typeof value !== 'string') {
            continue;
          }

          // `original_file_name` is a name and is allowed to hold one; every
          // other text column must be a code, a format, or an id.
          if (column === 'originalFileName') {
            continue;
          }

          expect(value).not.toContain(marker);
          expect(value).not.toContain('\x89PNG');
          expect(value).not.toContain('<svg');
          expect(value).not.toContain('alert');
        }

        expect(
          Object.values(record).some((value) => Buffer.isBuffer(value)),
        ).toBe(false);
      }
    });

    it('records the file name as a name, never as content', async () => {
      await convert(fixture('solid.png'), 'holiday-photo.png', 'jpeg');

      const record = await latestRecord();

      expect(record?.originalFileName).toBe('holiday-photo.png');
      expect(record!.originalFileName.length).toBeLessThanOrEqual(255);
    });
  });

  /**
   * The published document against the contract (Constitution V).
   *
   * Built from the running application rather than read from a file, so it is
   * the document callers actually receive. A decorator quietly dropped in a
   * refactor is exactly the kind of drift this catches — and the kind nothing
   * else would, since the routes keep working either way.
   */
  describe('the published OpenAPI document', () => {
    interface SchemaObject {
      type?: string;
      format?: string;
      enum?: string[];
      required?: string[];
      properties?: Record<string, SchemaObject>;
      $ref?: string;
    }

    interface Operation {
      tags: string[];
      requestBody?: {
        content: Record<string, { schema: SchemaObject }>;
      };
      responses: Record<
        string,
        {
          content?: Record<string, { schema: SchemaObject }>;
          headers?: Record<string, { schema: SchemaObject }>;
        }
      >;
    }

    interface Document {
      paths: Record<string, { get?: Operation; post?: Operation }>;
      components: {
        schemas: Record<string, { properties: Record<string, unknown> }>;
      };
    }

    let document: Document;

    beforeAll(() => {
      document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('audit').setVersion('1').build(),
      ) as unknown as Document;
    });

    const convert = () => document.paths['/api/images/convert'].post!;
    const formats = () => document.paths['/api/images/convert/formats'].get!;

    it('documents both routes under one tag', () => {
      expect(convert().tags).toEqual(['image-conversion']);
      expect(formats().tags).toEqual(['image-conversion']);
    });

    it('documents the three multipart parts', () => {
      const schema =
        convert().requestBody!.content['multipart/form-data'].schema;

      expect(Object.keys(convert().requestBody!.content)).toEqual([
        'multipart/form-data',
      ]);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        'file',
        'store',
        'targetFormat',
      ]);
      expect(schema.required?.sort()).toEqual(['file', 'targetFormat']);
      expect(schema.properties?.file.format).toBe('binary');
      expect(schema.properties?.targetFormat.enum?.sort()).toEqual([
        'jpeg',
        'png',
        'svg',
      ]);
    });

    /** Every status in the contract's error table has a response decorator. */
    it('documents every status the contract lists', () => {
      expect(Object.keys(convert().responses).sort()).toEqual([
        '200',
        '400',
        '401',
        '413',
        '415',
        '429',
        '500',
      ]);
      expect(Object.keys(formats().responses).sort()).toEqual([
        '200',
        '401',
        '429',
      ]);
    });

    it('documents the produced media types and both response headers', () => {
      const ok = convert().responses['200'];

      expect(Object.keys(ok.content ?? {}).sort()).toEqual([
        'image/jpeg',
        'image/png',
      ]);
      expect(Object.keys(ok.headers ?? {}).sort()).toEqual([
        'Content-Disposition',
        'X-Image-Conversion-Retention',
      ]);
      expect(ok.headers!['X-Image-Conversion-Retention'].schema.enum).toEqual([
        'not-requested',
        'stored',
        'failed',
      ]);
    });

    it('describes the discovery response by its DTO', () => {
      expect(
        Object.keys(
          document.components.schemas.SupportedImageFormatDto.properties,
        ).sort(),
      ).toEqual([
        'extension',
        'maxInputBytes',
        'mediaType',
        'source',
        'targets',
      ]);
      expect(
        (
          document.components.schemas.SupportedImageFormatsResponseDto
            .properties.formats as SchemaObject
        ).type,
      ).toBe('array');
    });

    it('describes every error body with the shared envelope', () => {
      for (const status of ['400', '413', '415', '500']) {
        expect(
          convert().responses[status].content!['application/json'].schema.$ref,
        ).toContain('ConversionErrorResponseDto');
      }
    });
  });

  it('observed no outbound connection over the whole suite', () => {
    expect(egress.observed).toBe(0);
  });
});
