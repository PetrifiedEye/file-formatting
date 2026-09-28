import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

const createPermissionDtoSchema = Joi.object<CreatePermissionDto>({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().allow('').max(500),
  actions: Joi.array().items(Joi.string().min(1).max(50)).unique().required(),
});

@JoiSchema(createPermissionDtoSchema)
export class CreatePermissionDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'docs' })
  name!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  description?: string;

  @ApiProperty({
    type: [String],
    example: ['read', 'write'],
    description: 'Must be non-empty (checked at the service layer, 422)',
  })
  actions!: string[];
}
