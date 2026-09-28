import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { uuidField } from '@/core/validation/joi-fields';

const createGrantDtoSchema = Joi.object<CreateGrantDto>({
  roleId: uuidField().required(),
  permissionId: uuidField().required(),
  actions: Joi.array().items(Joi.string().allow('')).unique(),
});

@JoiSchema(createGrantDtoSchema)
export class CreateGrantDto {
  @ApiProperty()
  roleId!: string;

  @ApiProperty()
  permissionId!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Subset of the permission actions; must be non-empty (422). ' +
      'Omitting it on create records every action the permission has today.',
  })
  actions?: string[];
}
