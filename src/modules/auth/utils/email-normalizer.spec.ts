import { normalizeEmail } from './email-normalizer';

describe('email-normalizer', () => {
  it('lowercases and trims email', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });
});
