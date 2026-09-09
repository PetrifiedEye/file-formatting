import { ApiProperty } from '@nestjs/swagger';

import { UserStatus } from '../entities/user.entity';

export class UserDirectoryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true, type: String })
  photo!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({ nullable: true, type: String })
  lastLoginAt!: Date | null;
}
