import Joi from 'joi';

/**
 * Reusable schema fragments. Each is a factory so callers can chain
 * `.required()` / `.optional()` without sharing a mutated instance.
 */

/**
 * Any RFC 4122 UUID, plus the nil and max UUIDs — the same set the previous
 * validator accepted, and every value Postgres will cast to `uuid`.
 */
const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export const uuidField = () =>
  Joi.string()
    .pattern(UUID_PATTERN)
    .messages({ 'string.pattern.base': '{#label} must be a UUID' });

/**
 * Top-level domains are not checked against a list: the address is proved by
 * the confirmation mail, not by the validator.
 */
export const emailField = () => Joi.string().email({ tlds: { allow: false } });

/** Page size for the cursor-paginated lists: a query-string integer. */
export const pageLimitField = () => Joi.number().integer().min(1).max(100);

/** `"true"` / `"false"` as sent in a multipart form field. */
export const multipartFlagField = () => Joi.string().valid('true', 'false');

/**
 * A colour transparency is composited onto: `transparent`, `#rrggbb` or
 * `#rrggbbaa`. Shared by the image route's `backgroundColor` field and the
 * `IMAGE_BACKGROUND_COLOR` default.
 */
export const BACKGROUND_COLOR_PATTERN =
  /^(?:transparent|#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)$/;

export const backgroundColorField = () =>
  Joi.string().pattern(BACKGROUND_COLOR_PATTERN);
