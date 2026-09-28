import type { ObjectSchema, ValidationError, ValidationOptions } from 'joi';

/**
 * One set of options for every request schema, so query strings, JSON bodies
 * and multipart fields behave alike:
 *
 * - `stripUnknown` drops keys the schema does not name (the old
 *   `whitelist: true`), so a handler never sees a field it did not ask for.
 * - `convert` lets query-string numbers (`?limit=20`) and trimmed strings
 *   through. JSON-body numbers and booleans opt out with `.strict()` in their
 *   schema, so `"true"` is not quietly accepted where `true` is required.
 * - `abortEarly: false` reports every problem at once, as the API always has.
 */
export const JOI_VALIDATION_OPTIONS: ValidationOptions = {
  abortEarly: false,
  stripUnknown: true,
  convert: true,
  errors: { wrap: { label: false } },
};

export type JoiValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      messages: string[];
      /** Top-level keys that failed, in schema order. */
      failedKeys: string[];
    };

/**
 * Validates `value` against `schema` with the shared options. A missing body
 * or query (`undefined` / `null`) is validated as `{}`, so required fields are
 * still reported instead of the whole object slipping through as absent.
 */
export function validateWithSchema<T>(
  schema: ObjectSchema<T>,
  value: unknown,
): JoiValidationResult<T> {
  const result = schema.validate(value ?? {}, JOI_VALIDATION_OPTIONS);

  if (result.error) {
    return {
      ok: false,
      messages: messagesOf(result.error),
      failedKeys: failedKeysOf(result.error),
    };
  }

  return { ok: true, value: result.value };
}

function messagesOf(error: ValidationError): string[] {
  return error.details.map((detail) => detail.message);
}

function failedKeysOf(error: ValidationError): string[] {
  const keys = error.details.map((detail) => String(detail.path[0] ?? ''));
  return [...new Set(keys)];
}
