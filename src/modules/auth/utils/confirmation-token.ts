import { createHash, randomBytes, randomInt } from 'crypto';

export interface ConfirmationTokens {
  otp: string;
  otpHash: string;
  linkToken: string;
  linkTokenHash: string;
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateConfirmationTokens(): ConfirmationTokens {
  const otp = randomInt(100000, 1000000).toString();
  const linkToken = randomBytes(32).toString('base64url');

  return {
    otp,
    otpHash: hashSecret(otp),
    linkToken,
    linkTokenHash: hashSecret(linkToken),
  };
}

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const EMAIL_CAP_WINDOW_MS = 10 * 60 * 1000;
export const EMAIL_CAP_MAX = 5;
