import { ApiProperty } from '@nestjs/swagger';

import { ConversionErrorCode } from '../conversion.constants';

/**
 * The single error envelope every failure uses.
 *
 * `message` never contains any fragment of the uploaded file: library parser
 * messages quote their input, so they are replaced by the fixed `code` plus, at
 * most, a line and column (FR-023, SC-005).
 */
export class ConversionErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({
    example: 'Input is malformed for its detected format at line 3, column 12',
    description: 'Fixed text plus, at most, a position. Never file content.',
  })
  message!: string;

  @ApiProperty({
    enum: Object.values(ConversionErrorCode),
    example: ConversionErrorCode.PARSE_ERROR,
    description: 'A fixed code, stable across releases.',
  })
  code!: ConversionErrorCode;
}
