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
});
