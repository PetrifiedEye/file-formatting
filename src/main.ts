import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from './core/app/app.module';
import {
  parseTrustProxy,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '@/core/bootstrap/bootstrap.options';
import { configureApp } from '@/core/bootstrap/configure-app';
import { ConfigService } from '@/core/config/config.service';

async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
      // On shutdown, close idle keep-alive sockets at once but let requests
      // already in flight finish, instead of severing them. Stated explicitly
      // rather than inherited, because it is what makes a rolling deploy
      // drain cleanly.
      forceCloseConnections: 'idle',
    }),
  );

  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);

  await configureApp(app);

  // Swagger describes every auth and admin surface; it stays out of production.
  const nodeEnv = configService.get('NODE_ENV');
  if (nodeEnv === 'development') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('File Formatting API — User Registration')
      .setDescription('Registration and email-confirmation endpoints')
      .setVersion('1.0.0')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();

  // `enableShutdownHooks` runs the Nest lifecycle on SIGTERM, and
  // `forceCloseConnections: 'idle'` above drains the in-flight requests. What
  // was missing is a bound on that drain: one request stuck on a slow query
  // could keep the process alive past the orchestrator's grace period, which
  // then turns a clean stop into a SIGKILL mid-write.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const forceExit = setTimeout(() => {
        logger.error(
          `Shutdown did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; exiting.`,
        );
        process.exit(1);
      }, SHUTDOWN_DRAIN_TIMEOUT_MS);
      forceExit.unref();
    });
  }

  const port = configService.get('PORT');

  // Bind on all interfaces: the Node default of 127.0.0.1 is unreachable from
  // outside a container even when the port is published.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
