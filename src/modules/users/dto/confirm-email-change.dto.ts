import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ConfirmEmailChangeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  code!: string;
}
