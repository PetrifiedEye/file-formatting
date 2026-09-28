import { BadRequestException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

const CURSOR_VERSION = 1;
const INVALID_CURSOR_MESSAGE = 'Invalid cursor';

interface CursorPayload {
  v: number;
  fp: string;
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

/**
 * Opaque, tamper-evident keyset cursors. `P` is the position carried inside:
 * the sort-key values of the last row served, as JSON-safe values.
 *
 * A cursor is `base64url(json).base64url(hmac-sha256(json))`, where the JSON is
 * `{ v, fp, ...position }`: a format version, the fingerprint of the query
 * that minted it, and the sort-key values of the last row served.
 *
 * The fingerprint binds a cursor to the exact query (filters, sort, page size,
 * and whose data is read), so one minted for one query cannot be replayed
 * against another. Every way a cursor can be wrong — malformed, forged, stale,
 * from another query — is the same `400 Invalid cursor`: distinguishing
 * "forged" from "stale" would tell a caller which of the two they achieved.
 */
export class CursorCodec<P extends object> {
  constructor(private readonly secret: string) {}

  /** A stable hash of the options that define the list being paged. */
  fingerprint(options: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(options)).digest('hex');
  }

  encode(fingerprint: string, position: P): string {
    const json = JSON.stringify({
      v: CURSOR_VERSION,
      fp: fingerprint,
      ...position,
    });

    return `${base64UrlEncode(Buffer.from(json, 'utf8'))}.${base64UrlEncode(
      this.sign(json),
    )}`;
  }

  decode(token: string, fingerprint: string): P {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) {
        throw new Error('malformed');
      }

      const [jsonPart, signaturePart] = parts;
      const json = base64UrlDecode(jsonPart).toString('utf8');

      const expected = this.sign(json);
      const actual = base64UrlDecode(signaturePart);

      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new Error('bad signature');
      }

      const { v, fp, ...position } = JSON.parse(json) as CursorPayload & P;

      if (v !== CURSOR_VERSION) {
        throw new Error('bad version');
      }

      if (fp !== fingerprint) {
        throw new Error('fingerprint mismatch');
      }

      return position as unknown as P;
    } catch {
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
  }

  private sign(json: string): Buffer {
    return createHmac('sha256', this.secret).update(json).digest();
  }
}
