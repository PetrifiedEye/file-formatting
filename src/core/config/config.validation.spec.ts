import { configValidationSchema } from './config.validation';

const baseEnv = {
  PORT: 3000,
  NODE_ENV: 'test',
  COOKIE_SECRET: 'cookie-secret',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: 5432,
  POSTGRES_USER: 'user',
  POSTGRES_PASSWORD: 'password',
  POSTGRES_DB: 'db',
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
  SMTP_FROM: 'noreply@example.com',
  APP_BASE_URL: 'http://localhost:3000',
  ASSETS_DIR: './assets',
  ASSETS_BASE_URL: 'http://localhost:3000',
};

describe('configValidationSchema', () => {
  it('accepts a complete environment', () => {
    expect(configValidationSchema.validate(baseEnv).error).toBeUndefined();
  });

  it('defaults POSTGRES_SYNCHRONIZE to false', () => {
    const { value } = configValidationSchema.validate(baseEnv) as {
      value: { POSTGRES_SYNCHRONIZE: boolean };
    };
    expect(value.POSTGRES_SYNCHRONIZE).toBe(false);
  });

  it('refuses to start with POSTGRES_SYNCHRONIZE=true', () => {
    // Auto-sync against this schema replaces the partial UNIQUE indexes
    // enforcing "one active challenge per user" with plain ones and drops the
    // check constraints, so it must not be reachable by setting a variable.
    const { error } = configValidationSchema.validate({
      ...baseEnv,
      POSTGRES_SYNCHRONIZE: 'true',
    });

    expect(error?.message).toMatch(/POSTGRES_SYNCHRONIZE must be false/);
  });

  describe('conversion limits', () => {
    const numericKeys = [
      'CONVERSION_MAX_BYTES_CSV',
      'CONVERSION_MAX_BYTES_JSON',
      'CONVERSION_MAX_BYTES_XML',
      'CONVERSION_MAX_BYTES_YAML',
      'CONVERSION_MAX_OUTPUT_BYTES',
      'CONVERSION_MAX_DEPTH',
      'CONVERSION_MAX_NODES',
      'CONVERSION_MAX_CSV_COLUMNS',
      'CONVERSION_TIMEOUT_MS',
      'CONVERSION_MAX_CONCURRENT',
    ] as const;

    it('applies every documented default when the keys are absent', () => {
      const { value } = configValidationSchema.validate(baseEnv) as {
        value: Record<string, unknown>;
      };

      expect(value.CONVERSION_MAX_BYTES_CSV).toBe(5242880);
      expect(value.CONVERSION_MAX_BYTES_JSON).toBe(5242880);
      expect(value.CONVERSION_MAX_BYTES_XML).toBe(5242880);
      expect(value.CONVERSION_MAX_BYTES_YAML).toBe(5242880);
      expect(value.CONVERSION_MAX_OUTPUT_BYTES).toBe(20971520);
      expect(value.CONVERSION_MAX_DEPTH).toBe(64);
      expect(value.CONVERSION_MAX_NODES).toBe(200000);
      expect(value.CONVERSION_MAX_CSV_COLUMNS).toBe(1024);
      expect(value.CONVERSION_TIMEOUT_MS).toBe(10000);
      expect(value.CONVERSION_MAX_CONCURRENT).toBe(4);
      expect(value.CONVERSION_STORAGE_DIR).toBe('./storage/conversions');
    });

    it('accepts administrator overrides', () => {
      const { error, value } = configValidationSchema.validate({
        ...baseEnv,
        CONVERSION_MAX_BYTES_CSV: 1024,
        CONVERSION_STORAGE_DIR: '/var/lib/app/conversions',
      }) as { error?: Error; value: Record<string, unknown> };

      expect(error).toBeUndefined();
      expect(value.CONVERSION_MAX_BYTES_CSV).toBe(1024);
      expect(value.CONVERSION_STORAGE_DIR).toBe('/var/lib/app/conversions');
    });

    // A zero or negative ceiling does not disable a guard — it refuses every
    // document while reporting a limit failure. Startup is the right place to
    // catch that, not the first conversion of the day.
    it.each(numericKeys)('rejects a zero %s', (key) => {
      const { error } = configValidationSchema.validate({
        ...baseEnv,
        [key]: 0,
      });

      expect(error).toBeDefined();
    });

    it.each(numericKeys)('rejects a negative %s', (key) => {
      const { error } = configValidationSchema.validate({
        ...baseEnv,
        [key]: -1,
      });

      expect(error).toBeDefined();
    });

    it.each(numericKeys)('rejects a non-numeric %s', (key) => {
      const { error } = configValidationSchema.validate({
        ...baseEnv,
        [key]: 'unlimited',
      });

      expect(error).toBeDefined();
    });

    it.each(numericKeys)('rejects a fractional %s', (key) => {
      const { error } = configValidationSchema.validate({
        ...baseEnv,
        [key]: 1.5,
      });

      expect(error).toBeDefined();
    });

    it('rejects an empty CONVERSION_STORAGE_DIR', () => {
      const { error } = configValidationSchema.validate({
        ...baseEnv,
        CONVERSION_STORAGE_DIR: '',
      });

      expect(error).toBeDefined();
    });
  });
});
