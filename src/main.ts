import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { resolve } from 'path';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from './core/app/app.module';
import { ConfigService } from '@/core/config/config.service';

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5174',
  'http://localhost:4200',
  'http://localhost:8080',
];

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') {
    return DEFAULT_CORS_ORIGINS;
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Fastify only honours `X-Forwarded-*` when `trustProxy` is set, and it has to
 * be set on the adapter (before the app exists), so it is read straight from
 * the environment rather than through `ConfigService`.
 *
 * Without it every request behind a reverse proxy reports the proxy's address:
 * `@Throttle` buckets all clients together and audit rows record one IP.
 *
 * Accepted values: `false` (default, direct exposure), `true` (trust the whole
 * chain), a hop count (`1` = one proxy in front), or a comma-separated list of
 * trusted proxy addresses/CIDRs.
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim();

  if (!value || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  const hops = Number(value);
  if (Number.isInteger(hops) && hops > 0) {
    return hops;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    }),
  );

  await app.register(compression);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  const configService = app.get(ConfigService);
  const corsOrigins = parseCorsOrigins(configService.get('CORS_ORIGINS'));

  app.enableCors({
    origin: corsOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  await app.register(fastifyCookie, {
    secret: configService.get('COOKIE_SECRET'),
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Number(configService.get('PHOTO_MAX_SIZE_BYTES')),
      files: 1,
    },
  });

  await app.register(fastifyStatic, {
    root: resolve(configService.get('ASSETS_DIR')),
    prefix: '/assets/',
  });

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

  const port = configService.get('PORT');

  // Bind on all interfaces: the Node default of 127.0.0.1 is unreachable from
  // outside a container even when the port is published.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
