import { SystemSettings } from '@/modules/settings/entities/system-settings.entity';

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(
  password: string,
  policy: Pick<
    SystemSettings,
    | 'passwordMinLength'
    | 'passwordRequireUppercase'
    | 'passwordRequireDigit'
    | 'passwordRequireSpecial'
  >,
): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < policy.passwordMinLength) {
    errors.push(
      `Password must be at least ${policy.passwordMinLength} characters`,
    );
  }

  if (policy.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter');
  }

  if (policy.passwordRequireDigit && !/\d/.test(password)) {
    errors.push('Password must contain a digit');
  }

  if (policy.passwordRequireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain a special character');
  }

  return { valid: errors.length === 0, errors };
}
