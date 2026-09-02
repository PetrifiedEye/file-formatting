import { generateConfirmationTokens, hashSecret } from './confirmation-token';

describe('confirmation-token', () => {
  it('generates a 6-digit OTP and base64url link token', () => {
    const tokens = generateConfirmationTokens();
    expect(tokens.otp).toMatch(/^\d{6}$/);
    expect(tokens.linkToken.length).toBeGreaterThanOrEqual(32);
    expect(tokens.otpHash).toBe(hashSecret(tokens.otp));
    expect(tokens.linkTokenHash).toBe(hashSecret(tokens.linkToken));
  });

  it('produces unique tokens on each call', () => {
    const a = generateConfirmationTokens();
    const b = generateConfirmationTokens();
    expect(a.otp).not.toBe(b.otp);
    expect(a.linkToken).not.toBe(b.linkToken);
  });
});
