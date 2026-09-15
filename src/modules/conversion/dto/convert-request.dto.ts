import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

import { ConversionFormat } from '../conversion.enums';

/**
 * The non-file parts of a conversion request.
 *
 * The global `ValidationPipe` never sees a multipart body, so this DTO is
 * validated explicitly by the controller (`plainToInstance` + `validate`). It is
 * a DTO rather than a pair of `if` statements so that Swagger, the validation
 * rules, and the controller all describe the same contract.
 *
 * Both fields arrive as strings — multipart has no other type.
 */
export class ConvertRequestDto {
  @ApiProperty({
    enum: ConversionFormat,
    description: 'The format to convert into. Must differ from the source.',
  })
  @IsString()
  @IsIn(Object.values(ConversionFormat))
  targetFormat!: ConversionFormat;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description: 'Keep the converted file in application storage.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  store?: 'true' | 'false';
}
