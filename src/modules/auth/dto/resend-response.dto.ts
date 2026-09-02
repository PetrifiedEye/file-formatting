import { ApiProperty } from '@nestjs/swagger';

export class ResendResponseDto {
  @ApiProperty({
    example:
      'If a pending registration exists, a new confirmation email has been sent.',
  })
  message!: string;
}
