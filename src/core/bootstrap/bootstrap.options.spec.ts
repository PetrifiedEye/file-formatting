import { parseTrustProxy, resolveCorsOrigins } from './bootstrap.options';

describe('resolveCorsOrigins', () => {
  it('splits and trims a configured list', () => {
    expect(
      resolveCorsOrigins(
        ' https://a.example , https://b.example ',
        'production',
      ).origins,
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it.each([undefined, '', '   ', ' , '])(
    'refuses to start outside development when CORS_ORIGINS is %p',
    (raw) => {
      // Silently falling back to localhost on a credentialed CORS policy left
      // a deployed API refusing every real origin with no explanation.
      expect(() => resolveCorsOrigins(raw, 'production')).toThrow(
        /CORS_ORIGINS is not set/,
      );
      expect(() => resolveCorsOrigins(raw, undefined)).toThrow(
        /CORS_ORIGINS is not set/,
      );
    },
  );

  it('falls back to the localhost origins in development, and says so', () => {
    const result = resolveCorsOrigins(undefined, 'development');

    expect(result.origins).toContain('http://localhost:4200');
    expect(result.warning).toMatch(/CORS_ORIGINS is not set/);
  });
});

describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false'])('reads %p as false', (raw) => {
    expect(parseTrustProxy(raw)).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('reads a positive integer as a hop count', () => {
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('reads anything else as a list of trusted addresses', () => {
    expect(parseTrustProxy('10.0.0.1, 10.0.0.2')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });
});
