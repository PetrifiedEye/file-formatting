import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  BCRYPT_MAX_PASSWORD_BYTES,
  MaxPasswordBytes,
} from './max-password-bytes.validator';

class Subject {
  @MaxPasswordBytes()
  password!: string;
}

const errorsFor = (password: string): string[] =>
  validateSync(plainToInstance(Subject, { password })).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

describe('MaxPasswordBytes', () => {
  it('accepts a password at the limit', () => {
    expect(errorsFor('a'.repeat(BCRYPT_MAX_PASSWORD_BYTES))).toEqual([]);
  });

  it('rejects a password past the limit', () => {
    // bcrypt would hash only the first 72 bytes, so this password and its
    // 72-byte prefix would both open the account.
    expect(errorsFor('a'.repeat(BCRYPT_MAX_PASSWORD_BYTES + 1))).not.toEqual(
      [],
    );
  });

  it('counts bytes, not characters', () => {
    // 36 three-byte characters: inside a character-based limit, past the
    // byte-based one bcrypt actually applies.
    expect(errorsFor('€'.repeat(36))).not.toEqual([]);
  });
});
