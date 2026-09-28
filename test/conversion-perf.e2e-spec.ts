import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { User, UserStatus } from '../src/modules/users/entities/user.entity';
import { hashPassword } from '../src/modules/auth/utils/password-hasher';
import { createTestApp } from './support/create-test-app';

const TEST_PASSWORD = 'CorrectHorse123!';

function cookieOf(header: string[] | undefined): string {
  const c = (header ?? []).find((v) => v.startsWith('access_token='));
  if (!c) throw new Error('no cookie');
  return c.split(';')[0];
}

/** ~1 MiB of realistic JSON. */
function oneMiBJson(): Buffer {
  const rows: Record<string, string>[] = [];
  while (Buffer.byteLength(JSON.stringify(rows)) < 1024 * 1024) {
    rows.push({
      id: String(rows.length),
      name: `user-${rows.length}`,
      email: `user${rows.length}@example.com`,
      city: 'Rome',
      note: 'lorem ipsum dolor sit amet consectetur',
    });
  }
  return Buffer.from(JSON.stringify(rows), 'utf8');
}

/**
 * SC-002 and SC-008, measured against a real listening server.
 *
 * Opt-in (`RUN_PERF_TESTS=true npm run test:e2e`) because the assertions are
 * wall-clock thresholds: they are meaningful on a machine that is otherwise
 * idle and merely noisy on a shared CI runner. Keeping them out of the default
 * run is the difference between a measurement and a flaky test.
 *
 * Last measured (2026-09-28, local), with parsing on worker threads:
 *   SC-002  1 MiB JSON -> YAML 192ms, -> CSV 67ms, -> XML 88ms   (limit 5000ms)
 *   SC-008  10 concurrent 1 MiB conversions in 850ms, all 200;
 *           unrelated /health worst case 10ms vs 3ms idle        (limit 1000ms)
 *
 * Before the worker pool (2026-09-15, main thread): SC-008 took 3524ms and
 * /health's worst case under load was 694ms — within the limit, but only
 * because the per-format byte caps kept each synchronous parse short. The
 * `worker_threads` contingency of research.md §11 is now what runs.
 */
const describePerf =
  process.env.RUN_PERF_TESTS === 'true' ? describe : describe.skip;

describePerf('Conversion performance', () => {
  let app: INestApplication<App>;
  let cookie: string;
  let userRepository: Repository<User>;
  let throttler: ThrottlerStorageService;
  let email: string;
  let baseUrl: string;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    const mod: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    ({ app, baseUrl } = await createTestApp(mod));

    userRepository = mod.get(getRepositoryToken(User));
    throttler = mod.get<ThrottlerStorage>(
      ThrottlerStorage,
    ) as ThrottlerStorageService;

    email = `perf-${Date.now()}@example.com`;
    await userRepository.save(
      userRepository.create({
        email,
        passwordHash: await hashPassword(TEST_PASSWORD),
        status: UserStatus.ACTIVE,
      }),
    );
    const login = await request(baseUrl)
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD });
    cookie = cookieOf(login.headers['set-cookie'] as unknown as string[]);
  });

  afterAll(async () => {
    await userRepository.delete({ email });
    await app.close();
  });

  beforeEach(() => {
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  const convert = (body: Buffer, name: string, target: string) =>
    request(baseUrl)
      .post('/api/convert')
      .set('Cookie', cookie)
      .attach('file', body, name)
      .field('targetFormat', target);

  it('SC-002: converts 1 MiB in under 5 seconds', async () => {
    const body = oneMiBJson();
    const timings: number[] = [];

    for (const target of ['yaml', 'csv', 'xml']) {
      throttler.storage.clear();
      const started = Date.now();
      const response = await convert(body, 'big.json', target);
      const elapsed = Date.now() - started;
      timings.push(elapsed);

      console.log(
        `SC-002 json->${target}: ${body.byteLength} bytes in ${elapsed}ms -> ${response.status}`,
      );
      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(5000);
    }

    console.log('SC-002 timings', timings);
  }, 60000);

  it('SC-008: ten concurrent 1 MiB conversions do not delay /health by >1s', async () => {
    const body = oneMiBJson();

    const baseline: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = Date.now();
      await request(baseUrl).get('/health');
      baseline.push(Date.now() - t);
    }

    const worst: number[] = [];
    let probing = true;
    const prober = (async () => {
      while (probing) {
        const t = Date.now();
        await request(baseUrl).get('/health');
        worst.push(Date.now() - t);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    throttler.storage.clear();
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => convert(body, 'big.json', 'yaml')),
    );
    const total = Date.now() - started;
    probing = false;
    await prober;

    const maxProbe = Math.max(...worst);

    console.log(
      `SC-008: 10x1MiB in ${total}ms; statuses ${results
        .map((r) => r.status)
        .join(',')}; baseline health max=${Math.max(
        ...baseline,
      )}ms; under load max=${maxProbe}ms over ${worst.length} probes`,
    );

    expect(maxProbe).toBeLessThan(1000);
  }, 120000);
});
