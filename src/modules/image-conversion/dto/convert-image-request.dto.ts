import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional } from 'class-validator';

import { ImageFormat } from '@/modules/conversion/conversion.enums';

/**
 * The non-file parts of a conversion request.
 *
 * Applied by hand rather than by the global `ValidationPipe`, which never sees
 * a multipart body — a DTO that is silently skipped is worse than no DTO, so
 * the service invokes `validate` explicitly.
 *
 * Multipart fields arrive as strings, hence `store` being `'true'`/`'false'`
 * rather than a boolean: coercing here would turn every unrecognised value
 * into `false` and lose the `invalid_store_flag` refusal.
 */
export class ConvertImageRequestDto {
  @ApiProperty({
    enum: ImageFormat,
    description:
      'The format to produce. `svg` is a real format and an accepted ' +
      'value, but no direction produces it, so it is always refused.',
  })
  @IsEnum(ImageFormat)
  targetFormat!: ImageFormat;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description: 'Keep the converted image in application storage.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  store?: 'true' | 'false';
}
