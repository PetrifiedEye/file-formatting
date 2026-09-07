import { ApiProperty } from '@nestjs/swagger';

export class LoginResponseDto {
  @ApiProperty({ example: 'Signed in.' })
  message!: string;

  @ApiProperty()
  verificationRequired!: boolean;
}
