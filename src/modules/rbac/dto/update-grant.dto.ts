import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateGrantDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Subset of the permission actions; must be non-empty (422). ' +
      'Omitting it on create records every action the permission has today.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  actions?: string[];
}
