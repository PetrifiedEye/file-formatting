import Joi from 'joi';

import { validateWithSchema } from '@/core/validation/joi-validation';

import { BCRYPT_MAX_PASSWORD_BYTES, passwordField } from './password-field';

const schema = Joi.object({ password: passwordField().required() });

const errorsFor = (password: string): string[] => {
  const result = validateWithSchema(schema, { password });
  return result.ok ? [] : result.messages;
};

describe('passwordField', () => {
  it('accepts a password at the limit', () => {
    expect(errorsFor('a'.repeat(BCRYPT_MAX_PASSWORD_BYTES))).toEqual([]);
  });

  it('rejects a password past the limit', () => {
    // bcrypt would hash only the first 72 bytes, so this password and its
    // 72-byte prefix would both open the account.
    expect(errorsFor('a'.repeat(BCRYPT_MAX_PASSWORD_BYTES + 1))).toEqual([
      'password must not exceed 72 bytes',
    ]);
  });

  it('counts bytes, not characters', () => {
    // 36 three-byte characters: inside a character-based limit, past the
    // byte-based one bcrypt actually applies.
    expect(errorsFor('€'.repeat(36))).toEqual([
      'password must not exceed 72 bytes',
    ]);
  });

  it('rejects a password shorter than 8 characters', () => {
    expect(errorsFor('short')).not.toEqual([]);
  });
});
