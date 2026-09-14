import { ApiProperty } from '@nestjs/swagger';

export class GrantResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  roleId!: string;

  @ApiProperty()
  permissionId!: string;

  @ApiProperty({ type: [String] })
  actions!: string[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
