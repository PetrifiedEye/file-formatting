import { ApiProperty } from '@nestjs/swagger';

export class RoleMemberResponseDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  roleId!: string;

  @ApiProperty()
  createdAt!: Date;
}
