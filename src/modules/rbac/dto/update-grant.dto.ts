import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateGrantDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Subset of the permission actions. Omit/empty = all actions.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  actions?: string[];
}
