import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const resendRequestDtoSchema = Joi.object<ResendRequestDto>({
  email: emailField().required(),
});

@JoiSchema(resendRequestDtoSchema)
export class ResendRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  email!: string;
}
