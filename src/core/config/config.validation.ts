import Joi from 'joi';

import { Config } from './config.types';

export const configValidationSchema = Joi.object<Config>({
  PORT: Joi.number().port().required(),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  /**
   * Cookie secret
   */
  COOKIE_SECRET: Joi.string().required(),

  /**
   * JWT session auth secrets
   */
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED: Joi.boolean().optional().default(false),

  /**
   * Reverse proxy (consumed in main.ts before the DI container exists)
   */
  TRUST_PROXY: Joi.string().allow('').optional().default('false'),

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL: Joi.number().optional().default(10000),
  THROTTLE_GLOBAL_LIMIT: Joi.number().optional().default(10),

  /**
   * How often each process rebuilds its in-memory RBAC snapshot from the
   * database, bounding how long a grant changed on another replica keeps being
   * honoured here. 0 disables the refresh (single-instance deployments, where
   * the post-mutation reload is already synchronous).
   */
  RBAC_SNAPSHOT_REFRESH_MS: Joi.number().min(0).optional().default(30000),

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: Joi.string().hostname().required(),
  POSTGRES_PORT: Joi.number().port().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  /**
   * Always false. `synchronize` against this schema is destructive, not merely
   * redundant: it replaces the partial UNIQUE indexes enforcing "one active
   * challenge per user" with plain ones, drops the admin-directory indexes and
   * the check constraints outright, and rewrites the named foreign keys. The
   * schema is owned by the migrations in `src/database/migrations`, so the
   * switch is rejected at startup rather than trusted to stay unset.
   */
  POSTGRES_SYNCHRONIZE: Joi.boolean()
    .valid(false)
    .optional()
    .default(false)
    .messages({
      'any.only':
        'POSTGRES_SYNCHRONIZE must be false: the schema is owned by migrations ' +
        '(npm run migration:run). Auto-sync drops unique indexes and check ' +
        'constraints this schema depends on.',
    }),
  POSTGRES_LOGGING: Joi.boolean().optional().default(false),
  POSTGRES_MIGRATIONS_RUN: Joi.boolean().optional().default(false),

  /**
   * SMTP email options
   */
  SMTP_HOST: Joi.string().hostname().required(),
  SMTP_PORT: Joi.number().port().required(),
  SMTP_USER: Joi.string().allow('').optional().default(''),
  SMTP_PASSWORD: Joi.string().allow('').optional().default(''),
  SMTP_FROM: Joi.string().email().required(),

  /**
   * Application URLs
   */
  APP_BASE_URL: Joi.string().uri().required(),
  CORS_ORIGINS: Joi.string().optional().default(''),

  /**
   * Local asset storage (profile photos)
   */
  ASSETS_DIR: Joi.string().required(),
  ASSETS_BASE_URL: Joi.string().uri().required(),
  PHOTO_MAX_SIZE_BYTES: Joi.number().optional().default(5242880),

  /**
   * File format conversion limits.
   *
   * Every numeric limit is a positive integer: a zero or negative ceiling would
   * not "disable" the guard, it would refuse every document while reporting a
   * limit failure, so it is rejected at startup instead.
   */
  CONVERSION_MAX_BYTES_CSV: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(5242880),
  CONVERSION_MAX_BYTES_JSON: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(5242880),
  CONVERSION_MAX_BYTES_XML: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(5242880),
  CONVERSION_MAX_BYTES_YAML: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(5242880),
  CONVERSION_MAX_OUTPUT_BYTES: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(20971520),
  CONVERSION_MAX_DEPTH: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(64),
  CONVERSION_MAX_NODES: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(200000),
  CONVERSION_MAX_CSV_COLUMNS: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(1024),
  CONVERSION_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(10000),
  CONVERSION_MAX_CONCURRENT: Joi.number()
    .integer()
    .positive()
    .optional()
    .default(4),
  /**
   * Not `ASSETS_DIR`: that tree is served unauthenticated by `@fastify/static`,
   * and retained results must stay private to their owner (FR-027).
   */
  CONVERSION_STORAGE_DIR: Joi.string()
    .min(1)
    .optional()
    .default('./storage/conversions'),
});
