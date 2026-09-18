import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  ConversionErrorCategory,
  RecordedFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';

import { TransformationHistoryStatus } from '../transformation-history.enums';

/**
 * One history entry, as the caller sees it.
 *
 * This class is the allow-list (FR-013, FR-014): `conversion_records` also
 * holds `original_file_name`, `failure_reason`, `retention_*`, `stored_file_id`
 * and `started_at`, and none of them has a field here to arrive in. The service
 * selects exactly these columns, so the exclusion is enforced by the query, not
 * only by the mapping.
 */
export class TransformationHistoryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: TransformationType })
  type!: TransformationType;

  /** Null when the attempt failed before the source format was determined. */
  @ApiProperty({ enum: RecordedFormat, nullable: true })
  sourceFormat!: RecordedFormat | null;

  /** Null when the request named a format we do not support. */
  @ApiProperty({ enum: RecordedFormat, nullable: true })
  targetFormat!: RecordedFormat | null;

  @ApiProperty({ enum: TransformationHistoryStatus })
  status!: TransformationHistoryStatus;

  @ApiProperty({ description: 'Source file size in bytes' })
  fileSize!: number;

  @ApiProperty()
  durationMs!: number;

  /**
   * Present if and only if `status` is `error` — an invariant of the table's
   * own CHECK constraints, not a runtime branch.
   */
  @ApiPropertyOptional({ enum: ConversionErrorCategory })
  errorCode?: ConversionErrorCategory;

  @ApiProperty({ description: 'ISO 8601 timestamp' })
  createdAt!: string;
}
