import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class InitiateEmailChangeDto {
  @ApiProperty({ example: 'new@example.com' })
  @IsEmail()
  newEmail!: string;
}
