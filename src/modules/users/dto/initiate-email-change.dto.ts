import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { emailField } from '@/core/validation/joi-fields';

const initiateEmailChangeDtoSchema = Joi.object<InitiateEmailChangeDto>({
  newEmail: emailField().required(),
});

@JoiSchema(initiateEmailChangeDtoSchema)
export class InitiateEmailChangeDto {
  @ApiProperty({ example: 'new@example.com' })
  newEmail!: string;
}
