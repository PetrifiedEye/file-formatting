import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class AdminUpdateEmailDto {
  @ApiProperty({ example: 'admin-set@example.com' })
  @IsEmail()
  email!: string;
}
