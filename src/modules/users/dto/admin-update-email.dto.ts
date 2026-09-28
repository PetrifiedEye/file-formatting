import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const adminUpdateEmailDtoSchema = Joi.object<AdminUpdateEmailDto>({
  email: emailField().required(),
});

@JoiSchema(adminUpdateEmailDtoSchema)
export class AdminUpdateEmailDto {
  @ApiProperty({ example: 'admin-set@example.com' })
  email!: string;
}
