import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const createRoleDtoSchema = Joi.object<CreateRoleDto>({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().allow('').max(500),
});

@JoiSchema(createRoleDtoSchema)
export class CreateRoleDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'editor' })
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  description?: string;
}
