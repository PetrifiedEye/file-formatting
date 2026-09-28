import { ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const updateGrantDtoSchema = Joi.object<UpdateGrantDto>({
  actions: Joi.array().items(Joi.string().allow('')).unique(),
});

@JoiSchema(updateGrantDtoSchema)
export class UpdateGrantDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Subset of the permission actions; must be non-empty (422). ' +
      'Omitting it on create records every action the permission has today.',
  })
  actions?: string[];
}
