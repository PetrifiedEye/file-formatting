import { ApiProperty } from '@nestjs/swagger';

import { ConversionFormat } from '../conversion.enums';

export class SupportedFormatDto {
  @ApiProperty({ enum: ConversionFormat, example: ConversionFormat.CSV })
  source!: ConversionFormat;

  @ApiProperty({ example: 'text/csv' })
  mediaType!: string;

  @ApiProperty({ example: 'csv' })
  extension!: string;

  @ApiProperty({
    example: 5242880,
    description:
      "This source format's configured input limit, so a client can refuse " +
      'an oversized file before uploading it (FR-016).',
  })
  maxInputBytes!: number;

  @ApiProperty({
    enum: ConversionFormat,
    isArray: true,
    example: [
      ConversionFormat.JSON,
      ConversionFormat.XML,
      ConversionFormat.YAML,
    ],
    description: 'Never contains `source` itself (FR-004).',
  })
  targets!: ConversionFormat[];
}

/**
 * Every conversion direction the service actually accepts.
 *
 * Derived from the registered handlers at request time, never a hand-maintained
 * constant — so a newly registered format appears here with no further change
 * (FR-030, SC-009), and the advertised set cannot drift from what conversion
 * accepts (FR-012).
 */
export class SupportedFormatsResponseDto {
  @ApiProperty({
    type: [SupportedFormatDto],
    description: 'Sources alphabetically; each one’s targets alphabetically.',
  })
  formats!: SupportedFormatDto[];
}
