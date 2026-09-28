import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import helmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { resolve } from 'path';

import { resolveCorsOrigins } from '@/core/bootstrap/bootstrap.options';
import { ConfigService } from '@/core/config/config.service';

/**
 * Everything the HTTP surface depends on besides the module graph: plugins,
 * security headers, validation, CORS. Shared by `main.ts` and the e2e suites,
 * so the tests exercise the same headers, compression and parsing as
 * production instead of a hand-assembled approximation of it.
 *
 * Must run before `app.init()`: `@fastify/compress` attaches itself to routes
 * in an `onRoute` hook, so routes registered earlier are never compressed.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get('NODE_ENV');

  await app.register(compression);

  // User-uploaded files are served from `assets/` on this same origin, so a
  // file the browser sniffs as HTML would run as same-origin script. Helmet
  // supplies the standard set: nosniff, frame-ancestors, referrer policy, HSTS.
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
    hsts: nodeEnv === 'production',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  const cors = resolveCorsOrigins(configService.get('CORS_ORIGINS'), nodeEnv);

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
}
