import { ApiProperty } from '@nestjs/swagger';

import { UserDirectoryItemDto } from './user-directory-item.dto';

export class UserDirectoryPageDto {
  @ApiProperty({ type: [UserDirectoryItemDto] })
  items!: UserDirectoryItemDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
