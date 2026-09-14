import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * bcrypt hashes at most 72 bytes of input and silently discards the rest, so
 * without a bound two different passwords sharing a 72-byte prefix both open
 * the same account, and the extra bytes only cost the server hashing work.
 *
 * The limit is a *byte* count: a 72-character password of multi-byte
 * characters is well past it, which a plain `@MaxLength(72)` would wave
 * through.
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export function MaxPasswordBytes(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'maxPasswordBytes',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' &&
            Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must not exceed ${BCRYPT_MAX_PASSWORD_BYTES} bytes`;
        },
      },
    });
  };
}
