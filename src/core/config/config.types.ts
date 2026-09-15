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
   * How often each process rebuilds its in-memory RBAC snapshot from the
   * database. 0 disables the refresh.
   */
  RBAC_SNAPSHOT_REFRESH_MS?: number;

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

  /**
   * File format conversion limits.
   *
   * The input ceiling is per source format because the cost of a byte differs
   * by format: the limit applied is always the one for the *detected* source
   * format, so the same byte count can be accepted as XML and refused as CSV.
   */
  CONVERSION_MAX_BYTES_CSV?: number;
  CONVERSION_MAX_BYTES_JSON?: number;
  CONVERSION_MAX_BYTES_XML?: number;
  CONVERSION_MAX_BYTES_YAML?: number;

  /** Ceiling on the produced document; conversion fails rather than truncates. */
  CONVERSION_MAX_OUTPUT_BYTES?: number;

  /** Structural guards applied to the parsed document, whatever produced it. */
  CONVERSION_MAX_DEPTH?: number;
  CONVERSION_MAX_NODES?: number;

  /** Widest CSV output permitted; a wider header is refused, never truncated. */
  CONVERSION_MAX_CSV_COLUMNS?: number;

  /** Per-conversion wall-clock budget. */
  CONVERSION_TIMEOUT_MS?: number;

  /**
   * How many conversions may hold a parsed document in memory at once.
   *
   * This bounds **memory, not latency**: Node runs one synchronous parse at a
   * time regardless. What it prevents is N concurrent uploads each holding an
   * input buffer and its expanded model.
   */
  CONVERSION_MAX_CONCURRENT?: number;

  /**
   * Root for retained conversion results. Deliberately NOT `ASSETS_DIR`, which
   * `@fastify/static` serves unauthenticated at `/assets/`; retained results
   * are private to their owner and are not served over HTTP at all.
   */
  CONVERSION_STORAGE_DIR: string;
}
