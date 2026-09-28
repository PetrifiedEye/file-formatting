import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';
import {
  BCRYPT_MAX_PASSWORD_BYTES,
  passwordField,
} from '../validators/password-field';

const passwordResetConfirmDtoSchema = Joi.object<PasswordResetConfirmDto>({
  email: emailField().required(),
  code: Joi.string().allow('').required(),
  newPassword: passwordField().required(),
});

@JoiSchema(passwordResetConfirmDtoSchema)
export class PasswordResetConfirmDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;

  @ApiProperty({ example: '123456' })
  code!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: BCRYPT_MAX_PASSWORD_BYTES,
    example: 'newsecurepass',
  })
  newPassword!: string;
}
