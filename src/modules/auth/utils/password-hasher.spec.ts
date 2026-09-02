import { hashPassword, verifyPassword } from './password-hasher';

describe('password-hasher', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('testpassword');
    expect(hash).not.toBe('testpassword');
    expect(await verifyPassword('testpassword', hash)).toBe(true);
    expect(await verifyPassword('wrongpassword', hash)).toBe(false);
  });
});
