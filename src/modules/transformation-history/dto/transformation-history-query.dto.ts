import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import {
  ConversionFormat,
  ImageFormat,
  RecordedFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';

import { TransformationHistoryStatus } from '../transformation-history.enums';

/**
 * Every filter is optional and they combine with AND (FR-010). Nothing here is
 * coerced or guessed at: an unrecognized value is a 400, never a silently
 * dropped predicate that would return more than the caller asked for (FR-011).
 *
 * Cross-field checks — the date range's order, and whether a cursor belongs to
 * this filter set — are service-level, since neither is a property of a single
 * field.
 */
export class TransformationHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'From a previous page’s nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ enum: TransformationType })
  @IsOptional()
  @IsEnum(TransformationType)
  type?: TransformationType;

  @ApiPropertyOptional({ enum: { ...ConversionFormat, ...ImageFormat } })
  @IsOptional()
  @IsEnum(RecordedFormat)
  sourceFormat?: RecordedFormat;

  @ApiPropertyOptional({ enum: { ...ConversionFormat, ...ImageFormat } })
  @IsOptional()
  @IsEnum(RecordedFormat)
  targetFormat?: RecordedFormat;

  @ApiPropertyOptional({ enum: TransformationHistoryStatus })
  @IsOptional()
  @IsEnum(TransformationHistoryStatus)
  status?: TransformationHistoryStatus;

  @ApiPropertyOptional({ description: 'ISO 8601 datetime, inclusive' })
  @IsOptional()
  @IsISO8601()
  createdAtFrom?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 datetime, inclusive; must not precede createdAtFrom',
  })
  @IsOptional()
  @IsISO8601()
  createdAtTo?: string;
}
