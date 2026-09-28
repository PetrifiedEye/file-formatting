import { ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const updateRoleDtoSchema = Joi.object<UpdateRoleDto>({
  name: Joi.string().min(1).max(100),
  description: Joi.string().allow('').max(500),
});

@JoiSchema(updateRoleDtoSchema)
export class UpdateRoleDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100, example: 'editor' })
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  description?: string;
}
