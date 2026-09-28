import { ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import {
  ConversionFormat,
  ImageFormat,
  RecordedFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';

import { TransformationHistoryStatus } from '../transformation-history.enums';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { pageLimitField } from '@/core/validation/joi-fields';

const transformationHistoryQueryDtoSchema =
  Joi.object<TransformationHistoryQueryDto>({
    limit: pageLimitField(),
    cursor: Joi.string().allow(''),
    type: Joi.string().valid(...Object.values(TransformationType)),
    sourceFormat: Joi.string().valid(...Object.values(RecordedFormat)),
    targetFormat: Joi.string().valid(...Object.values(RecordedFormat)),
    status: Joi.string().valid(...Object.values(TransformationHistoryStatus)),
    createdAtFrom: Joi.string().isoDate(),
    createdAtTo: Joi.string().isoDate(),
  });

/**
 * Every filter is optional and they combine with AND (FR-010). Nothing here is
 * coerced or guessed at: an unrecognized value is a 400, never a silently
 * dropped predicate that would return more than the caller asked for (FR-011).
 *
 * Cross-field checks — the date range's order, and whether a cursor belongs to
 * this filter set — are service-level, since neither is a property of a single
 * field.
 */
@JoiSchema(transformationHistoryQueryDtoSchema)
export class TransformationHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  limit?: number;

  @ApiPropertyOptional({ description: 'From a previous page’s nextCursor' })
  cursor?: string;

  @ApiPropertyOptional({ enum: TransformationType })
  type?: TransformationType;

  @ApiPropertyOptional({ enum: { ...ConversionFormat, ...ImageFormat } })
  sourceFormat?: RecordedFormat;

  @ApiPropertyOptional({ enum: { ...ConversionFormat, ...ImageFormat } })
  targetFormat?: RecordedFormat;

  @ApiPropertyOptional({ enum: TransformationHistoryStatus })
  status?: TransformationHistoryStatus;

  @ApiPropertyOptional({ description: 'ISO 8601 datetime, inclusive' })
  createdAtFrom?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 datetime, inclusive; must not precede createdAtFrom',
  })
  createdAtTo?: string;
}
