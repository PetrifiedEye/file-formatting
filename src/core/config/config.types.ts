export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';

  /**
   * Cookie secret
   */
  COOKIE_SECRET: string;

  /**
   * JWT session auth secrets
   */
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED?: boolean;

  /**
   * Reverse proxy. Read directly from `process.env` in `main.ts` (the Fastify
   * adapter needs it before the DI container exists); declared here so the
   * validation schema documents and accepts it.
   * `false` | `true` | hop count | comma-separated trusted addresses.
   */
  TRUST_PROXY?: string;

  /**
   * Throttler options
   */
  THROTTLE_GLOBAL_TTL?: number;
  THROTTLE_GLOBAL_LIMIT?: number;

  /**
   * PostgreSQL database options
   */
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SYNCHRONIZE?: boolean;
  POSTGRES_LOGGING?: boolean;
  POSTGRES_MIGRATIONS_RUN?: boolean;

  /**
   * SMTP email options
   */
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM: string;

  /**
   * Application URLs
   */
  APP_BASE_URL: string;
  CORS_ORIGINS?: string;

  /**
   * Local asset storage (profile photos)
   */
  ASSETS_DIR: string;
  ASSETS_BASE_URL: string;
  PHOTO_MAX_SIZE_BYTES?: number;
}
