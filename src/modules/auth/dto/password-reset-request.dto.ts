import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const passwordResetRequestDtoSchema = Joi.object<PasswordResetRequestDto>({
  email: emailField().required(),
});

@JoiSchema(passwordResetRequestDtoSchema)
export class PasswordResetRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;
}
