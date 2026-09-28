import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const confirmCodeRequestDtoSchema = Joi.object<ConfirmCodeRequestDto>({
  email: emailField().required(),
  code: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required(),
});

@JoiSchema(confirmCodeRequestDtoSchema)
export class ConfirmCodeRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;

  @ApiProperty({ example: '123456', pattern: '^[0-9]{6}$' })
  code!: string;
}
