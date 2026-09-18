import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

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

export class UpdateTransformationRetentionPolicyRequestDto {
  @ApiProperty({
    description:
      'Lifetime applied to newly created transformation-history records',
    example: 180,
    minimum: 1,
    maximum: 3650,
  })
  @IsInt()
  @Min(1)
  @Max(3650)
  retentionDays!: number;
}
