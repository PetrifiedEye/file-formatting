import { ApiProperty } from '@nestjs/swagger';

import { TransformationHistoryItemDto } from './transformation-history-item.dto';

export class TransformationHistoryPageDto {
  @ApiProperty({ type: [TransformationHistoryItemDto] })
  items!: TransformationHistoryItemDto[];

  /** `null` on the last page — always present, never an empty string (FR-007). */
  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;

  @ApiProperty({
    description:
      'How many items match the current filters across all pages. ' +
      'Independent of the cursor: it stays the same while paging.',
    example: 42,
    minimum: 0,
  })
  total!: number;
}
