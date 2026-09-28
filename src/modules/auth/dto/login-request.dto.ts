import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';
import {
  BCRYPT_MAX_PASSWORD_BYTES,
  passwordField,
} from '../validators/password-field';

const loginRequestDtoSchema = Joi.object<LoginRequestDto>({
  email: emailField().required(),
  password: passwordField().required(),
});

@JoiSchema(loginRequestDtoSchema)
export class LoginRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: BCRYPT_MAX_PASSWORD_BYTES,
    example: 'securepass',
  })
  password!: string;
}
