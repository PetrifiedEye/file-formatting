import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

import {
  BCRYPT_MAX_PASSWORD_BYTES,
  MaxPasswordBytes,
} from '../validators/max-password-bytes.validator';

export class RegisterRequestDto {
  @ApiProperty({ example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    minLength: 8,
    maxLength: BCRYPT_MAX_PASSWORD_BYTES,
    example: 'securepass',
  })
  @IsString()
  @MinLength(8)
  @MaxPasswordBytes()
  password!: string;
}
