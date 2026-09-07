import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { UserStatus } from '../entities/user.entity';

export class UserProfileResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  photo!: string | null;

  @ApiPropertyOptional()
  email?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;

  @ApiPropertyOptional()
  createdAt?: Date;
}
