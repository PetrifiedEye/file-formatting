import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const confirmEmailChangeDtoSchema = Joi.object<ConfirmEmailChangeDto>({
  code: Joi.string().allow('').required(),
});

@JoiSchema(confirmEmailChangeDtoSchema)
export class ConfirmEmailChangeDto {
  @ApiProperty({ example: '123456' })
  code!: string;
}
