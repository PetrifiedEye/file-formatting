import { validatePassword } from './password-policy.validator';

const basePolicy = {
  passwordMinLength: 8,
  passwordRequireUppercase: false,
  passwordRequireDigit: false,
  passwordRequireSpecial: false,
};

describe('password-policy.validator', () => {
  it('accepts a password meeting minimum length', () => {
    const result = validatePassword('validpass', basePolicy);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a password below minimum length', () => {
    const result = validatePassword('short', basePolicy);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('at least 8');
  });

  it('enforces uppercase requirement', () => {
    const result = validatePassword('validpass1', {
      ...basePolicy,
      passwordRequireUppercase: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('uppercase');
  });

  it('enforces digit requirement', () => {
    const result = validatePassword('ValidPass', {
      ...basePolicy,
      passwordRequireDigit: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('digit');
  });

  it('enforces special character requirement', () => {
    const result = validatePassword('ValidPass1', {
      ...basePolicy,
      passwordRequireSpecial: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('special');
  });
});
