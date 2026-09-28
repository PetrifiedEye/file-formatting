import { ApiProperty } from '@nestjs/swagger';

import { UserDirectoryItemDto } from './user-directory-item.dto';

export class UserDirectoryPageDto {
  @ApiProperty({ type: [UserDirectoryItemDto] })
  items!: UserDirectoryItemDto[];

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
