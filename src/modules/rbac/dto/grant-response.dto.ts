import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GrantResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  roleId!: string;

  @ApiProperty()
  permissionId!: string;

  @ApiPropertyOptional({ type: [String], nullable: true })
  actions!: string[] | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
