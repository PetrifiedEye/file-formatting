import { ApiProperty } from '@nestjs/swagger';

export class ConfirmSuccessResponseDto {
  @ApiProperty({
    example: 'Your account is ready. You may sign in with your credentials.',
  })
  message!: string;

  @ApiProperty({ example: true })
  accountReady!: boolean;
}
