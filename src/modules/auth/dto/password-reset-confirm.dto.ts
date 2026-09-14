import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

import {
  BCRYPT_MAX_PASSWORD_BYTES,
  MaxPasswordBytes,
} from '../validators/max-password-bytes.validator';

export class PasswordResetConfirmDto {
  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  code!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: BCRYPT_MAX_PASSWORD_BYTES,
    example: 'newsecurepass',
  })
  @IsString()
  @MinLength(8)
  @MaxPasswordBytes()
  newPassword!: string;
}
