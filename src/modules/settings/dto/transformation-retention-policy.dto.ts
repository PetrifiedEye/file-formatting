import { ApiProperty } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

export class TransformationRetentionPolicyResponseDto {
  @ApiProperty({
    description:
      'Lifetime applied to newly created transformation-history records',
    example: 90,
    minimum: 1,
    maximum: 3650,
  })
  retentionDays!: number;
}

const updateTransformationRetentionPolicyRequestDtoSchema =
  Joi.object<UpdateTransformationRetentionPolicyRequestDto>({
    retentionDays: Joi.number().strict().integer().min(1).max(3650).required(),
  });

@JoiSchema(updateTransformationRetentionPolicyRequestDtoSchema)
export class UpdateTransformationRetentionPolicyRequestDto {
  @ApiProperty({
    description:
      'Lifetime applied to newly created transformation-history records',
    example: 180,
    minimum: 1,
    maximum: 3650,
  })
  retentionDays!: number;
}
