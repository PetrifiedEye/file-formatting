import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import helmet from '@fastify/helmet';
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
import {
  parseTrustProxy,
  resolveCorsOrigins,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '@/core/bootstrap/bootstrap.options';
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

  await app.register(compression);

  // Responses carry no security headers at all today, and user-uploaded files
  // are served from `assets/` on this same origin — so a file the browser
  // sniffs as HTML runs as same-origin script. Helmet supplies the standard
  // set: nosniff, frame-ancestors, referrer policy, HSTS.
  await app.register(helmet, {
    // The API serves JSON and static assets, never a document that loads its
    // own scripts or styles, so the default CSP is locked down further: no
    // subresource of any kind, and no framing.
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'none'"],
        // Same-origin only, and only what the dev Swagger page needs: its own
        // bundle, its own stylesheet, and the XHRs its "Try it out" makes.
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // HSTS is meaningless (and misleading) when the app is reachable over
    // plain HTTP in development.
    hsts: configService.get('NODE_ENV') === 'production',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  const cors = resolveCorsOrigins(
    configService.get('CORS_ORIGINS'),
    configService.get('NODE_ENV'),
  );

  if (cors.warning) {
    logger.warn(cors.warning);
  }

  app.enableCors({
    origin: cors.origins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    exposedHeaders: [
      'Content-Disposition',
      'X-Conversion-Retention',
      'X-Image-Conversion-Retention',
    ],
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
