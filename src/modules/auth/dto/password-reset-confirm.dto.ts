import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code!: string;

  @ApiProperty({ minLength: 8, example: 'newsecurepass' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
