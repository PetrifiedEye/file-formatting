import { ApiProperty } from '@nestjs/swagger';

export class RegisterResponseDto {
  @ApiProperty({
    example:
      'If this email is eligible, registration instructions have been sent.',
  })
  message!: string;

  @ApiProperty()
  confirmationRequired!: boolean;
}
