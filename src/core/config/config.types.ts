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
  SMTP_SECURE?: boolean;
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

  /**
   * Delay between expired transformation-history cleanup cycles.
   * 0 disables the in-process scheduler.
   */
  TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS?: number;

  /**
   * Image conversion limits.
   *
   * The input ceiling is per source format for the same reason the text
   * conversion one is — the limit applied is the *detected* source format's —
   * but the numbers differ in kind: a megabyte of SVG is a few thousand
   * characters that can demand gigabytes of pixels, so its cap is the tightest
   * of the three and the real guard is the intrinsic-size rule.
   */
  IMAGE_MAX_BYTES_PNG?: number;
  IMAGE_MAX_BYTES_JPEG?: number;
  IMAGE_MAX_BYTES_SVG?: number;

  /** Largest rasterisation permitted, checked *before* the renderer is built. */
  IMAGE_MAX_OUTPUT_WIDTH?: number;
  IMAGE_MAX_OUTPUT_HEIGHT?: number;

  /**
   * Decoded pixel budget, read from the container header before any pixel
   * buffer is allocated. Peak raster memory is bounded by
   * `IMAGE_MAX_PIXELS x 4 bytes x IMAGE_MAX_CONCURRENT`.
   */
  IMAGE_MAX_PIXELS?: number;

  /** Ceiling on the produced image; conversion fails rather than truncates. */
  IMAGE_MAX_OUTPUT_BYTES?: number;

  /**
   * What transparency is composited onto when the target cannot hold alpha,
   * and what an SVG is rasterised over. `#rrggbb`.
   */
  IMAGE_BACKGROUND_COLOR?: string;

  /** Fixed output quality for JPEG. Never caller-supplied. */
  IMAGE_JPEG_QUALITY?: number;

  /** Per-conversion wall-clock budget. */
  IMAGE_CONVERSION_TIMEOUT_MS?: number;

  /**
   * How many image conversions may hold a decoded raster at once. Lower than
   * the text pipeline's, because an image's expanded form is far larger
   * relative to its upload than a parsed document's is.
   */
  IMAGE_MAX_CONCURRENT?: number;

  /**
   * Fonts available to SVG rasterisation. Empty means no fonts at all and no
   * system-font scan, so `<text>` renders as nothing — deliberate, because
   * substituting whatever font a host happens to have would make output
   * non-reproducible across machines.
   */
  IMAGE_SVG_FONT_DIR?: string;
}
