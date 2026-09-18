import { ApiProperty } from '@nestjs/swagger';

import { TransformationHistoryItemDto } from './transformation-history-item.dto';

export class TransformationHistoryPageDto {
  @ApiProperty({ type: [TransformationHistoryItemDto] })
  items!: TransformationHistoryItemDto[];

  /** `null` on the last page — always present, never an empty string (FR-007). */
  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
