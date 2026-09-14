/**
 * Pure helpers for the Fastify bootstrap in `main.ts`, kept separate so they
 * can be unit-tested without booting an application.
 */

const DEVELOPMENT_CORS_ORIGINS = [
  'http://localhost:5174',
  'http://localhost:4200',
  'http://localhost:8080',
];

/**
 * How long in-flight requests get to finish once shutdown starts. Fastify
 * stops accepting connections immediately; anything still running past this
 * is cut off so a stuck request cannot hold the process open forever.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

export interface CorsOriginResolution {
  origins: string[];
  /** Set when no origins were configured and the dev defaults were used. */
  warning?: string;
}

/**
 * CORS is credentialed (`credentials: true`), so the origin list decides which
 * sites may make authenticated calls on a signed-in user's behalf. An unset
 * `CORS_ORIGINS` used to fall back to localhost in silence, which in a
 * production deployment means every real origin is refused and nobody is told
 * why. Outside development it is now a startup failure.
 */
export function resolveCorsOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined,
): CorsOriginResolution {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length > 0) {
    return { origins };
  }

  if (nodeEnv !== 'development') {
    throw new Error(
      `CORS_ORIGINS is not set. It has no safe default outside development ` +
        `(NODE_ENV=${nodeEnv ?? 'unset'}): set it to the comma-separated list ` +
        `of origins allowed to make credentialed requests.`,
    );
  }

  return {
    origins: DEVELOPMENT_CORS_ORIGINS,
    warning:
      `CORS_ORIGINS is not set; falling back to the development origins ` +
      `${DEVELOPMENT_CORS_ORIGINS.join(', ')}.`,
  };
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
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string[] {
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
