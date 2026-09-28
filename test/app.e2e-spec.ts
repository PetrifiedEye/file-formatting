import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';
import { createTestApp } from './support/create-test-app';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    ({ app, baseUrl } = await createTestApp(moduleFixture));
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET)', () => {
    return request(baseUrl).get('/health').expect(200);
  });

  describe('security headers', () => {
    it('sends the helmet header set on every response', async () => {
      const response = await request(baseUrl).get('/health').expect(200);

      expect(response.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'cross-origin-resource-policy': 'same-site',
        'referrer-policy': 'no-referrer',
      });

      const csp = response.headers['content-security-policy'];
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'none'");
    });

    it('sends them on errors too', async () => {
      const response = await request(baseUrl).get('/no-such-route').expect(404);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
    });

    it('does not send HSTS outside production', async () => {
      const response = await request(baseUrl).get('/health').expect(200);

      expect(response.headers['strict-transport-security']).toBeUndefined();
    });
  });
});
