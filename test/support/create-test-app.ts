import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { TestingModule } from '@nestjs/testing';

import { configureApp } from '../../src/core/bootstrap/configure-app';

export interface TestApp {
  app: NestFastifyApplication;
  baseUrl: string;
}

/**
 * Builds, configures and starts an e2e application exactly the way `main.ts`
 * does (same plugins, headers, pipes and CORS), then listens on an ephemeral
 * port.
 *
 * Listens for real: concurrent supertest calls against one un-listened server
 * object interleave onto the same ephemeral socket and produce bogus parse
 * errors.
 *
 * `beforeInit` runs after configuration and before `app.init()`, for suites
 * that attach test-only hooks (see `attachRbacTestAuth`).
 */
export async function createTestApp(
  moduleFixture: TestingModule,
  options: { beforeInit?: (app: NestFastifyApplication) => void } = {},
): Promise<TestApp> {
  const app = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  await configureApp(app);
  options.beforeInit?.(app);

  await app.init();
  await app.listen(0, '127.0.0.1');
  await app.getHttpAdapter().getInstance().ready();

  return { app, baseUrl: await app.getUrl() };
}
