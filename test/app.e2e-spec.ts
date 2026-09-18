import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );

    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
    // Listen for real: concurrent supertest calls against one un-listened
    // server object interleave onto the same ephemeral socket and produce
    // bogus parse errors.
    await app.listen(0, '127.0.0.1');
    await app.getHttpAdapter().getInstance().ready();
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(baseUrl).get('/health').expect(200);
  });
});
