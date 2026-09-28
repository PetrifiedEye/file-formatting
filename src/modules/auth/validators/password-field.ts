import Joi from 'joi';

/**
 * bcrypt hashes at most 72 bytes of input and silently discards the rest, so
 * without a bound two different passwords sharing a 72-byte prefix both open
 * the same account, and the extra bytes only cost the server hashing work.
 *
 * The limit is a *byte* count: a 72-character password of multi-byte
 * characters is well past it, which a character-based `max(72)` would wave
 * through.
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export const PASSWORD_MIN_LENGTH = 8;

/**
 * A password as submitted to register, sign in or reset: at least 8
 * characters, at most 72 UTF-8 bytes. Policy rules (uppercase, digit, …) are
 * applied later by `validatePassword`, against the admin-configured policy.
 */
export const passwordField = () =>
  Joi.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(BCRYPT_MAX_PASSWORD_BYTES, 'utf8')
    .messages({
      'string.max': `{#label} must not exceed ${BCRYPT_MAX_PASSWORD_BYTES} bytes`,
    });
