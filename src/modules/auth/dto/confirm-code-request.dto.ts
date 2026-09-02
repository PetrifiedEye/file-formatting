import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches } from 'class-validator';

export class ConfirmCodeRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456', pattern: '^[0-9]{6}$' })
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code!: string;
}
