import { BadRequestException } from '@nestjs/common';

import { CursorCodec } from './cursor-codec';

interface Position {
  id: string;
  createdAt: string;
}

describe('CursorCodec', () => {
  const codec = new CursorCodec<Position>('secret');
  const fingerprint = codec.fingerprint({ limit: 20, status: null });
  const position = { id: 'row-1', createdAt: '2026-09-18T10:00:00.000Z' };

  it('round-trips a position', () => {
    const token = codec.encode(fingerprint, position);

    expect(codec.decode(token, fingerprint)).toEqual(position);
  });

  it('produces a URL-safe token', () => {
    expect(codec.encode(fingerprint, position)).toMatch(
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    );
  });

  it('keeps the established wire format, so issued cursors stay valid', () => {
    const [jsonPart] = codec.encode(fingerprint, position).split('.');
    const json = Buffer.from(jsonPart, 'base64url').toString('utf8');

    expect(JSON.parse(json)).toEqual({ v: 1, fp: fingerprint, ...position });
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'v',
      'fp',
      'id',
      'createdAt',
    ]);
  });

  it('fingerprints options deterministically', () => {
    expect(codec.fingerprint({ a: 1, b: null })).toBe(
      codec.fingerprint({ a: 1, b: null }),
    );
    expect(codec.fingerprint({ a: 1 })).not.toBe(codec.fingerprint({ a: 2 }));
  });

  describe('refuses, uniformly, every bad cursor', () => {
    const token = codec.encode(fingerprint, position);
    const [jsonPart, signaturePart] = token.split('.');
    const forgedJson = Buffer.from(
      JSON.stringify({ v: 1, fp: fingerprint, id: 'row-999', createdAt: 'x' }),
    ).toString('base64url');

    it.each([
      ['garbage', 'not-a-cursor'],
      ['too many parts', `${token}.extra`],
      ['a forged payload', `${forgedJson}.${signaturePart}`],
      ['a truncated signature', `${jsonPart}.${signaturePart.slice(0, 10)}`],
      [
        'a cursor signed with another secret',
        new CursorCodec<Position>('other').encode(fingerprint, position),
      ],
    ])('%s', (_label, bad) => {
      expect(() => codec.decode(bad, fingerprint)).toThrow(
        new BadRequestException('Invalid cursor'),
      );
    });

    it('a cursor minted for a different query', () => {
      expect(() =>
        codec.decode(token, codec.fingerprint({ limit: 50 })),
      ).toThrow(BadRequestException);
    });
  });
});
