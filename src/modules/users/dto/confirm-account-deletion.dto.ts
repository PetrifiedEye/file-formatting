import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const confirmAccountDeletionDtoSchema = Joi.object<ConfirmAccountDeletionDto>({
  code: Joi.string().allow('').required(),
});

@JoiSchema(confirmAccountDeletionDtoSchema)
export class ConfirmAccountDeletionDto {
  @ApiProperty({ example: '123456' })
  code!: string;
}
