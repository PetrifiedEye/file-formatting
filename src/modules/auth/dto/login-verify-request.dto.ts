import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const loginVerifyRequestDtoSchema = Joi.object<LoginVerifyRequestDto>({
  email: emailField().required(),
  code: Joi.string().length(6).required(),
});

@JoiSchema(loginVerifyRequestDtoSchema)
export class LoginVerifyRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;

  @ApiProperty({ example: '123456' })
  code!: string;
}
