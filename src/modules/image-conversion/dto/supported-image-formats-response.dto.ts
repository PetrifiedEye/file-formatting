import { ApiProperty } from '@nestjs/swagger';

import { ImageFormat } from '@/modules/conversion/conversion.enums';

export class SupportedImageFormatDto {
  @ApiProperty({ enum: ImageFormat, description: 'A format that can be read.' })
  source!: ImageFormat;

  @ApiProperty({ example: 'image/png' })
  mediaType!: string;

  @ApiProperty({
    example: 'jpg',
    description:
      'The attachment extension for this format. `jpeg` carries `jpg`, so ' +
      'the format name and the extension are free to differ.',
  })
  extension!: string;

  @ApiProperty({
    example: 10485760,
    description:
      "This source format's configured upload limit, so a client can refuse " +
      'an oversized file before uploading it.',
  })
  maxInputBytes!: number;

  @ApiProperty({
    enum: ImageFormat,
    isArray: true,
    example: ['jpeg'],
    description:
      'Formats this source can be converted into. Never contains `source`, ' +
      'and never contains `svg` on any entry: the SVG handler implements no ' +
      'encoder, so the pair cannot be computed.',
  })
  targets!: ImageFormat[];
}

export class SupportedImageFormatsResponseDto {
  @ApiProperty({
    type: [SupportedImageFormatDto],
    description:
      'Derived from the registered handlers at request time, so this is ' +
      'exactly the set POST /api/images/convert accepts.',
  })
  formats!: SupportedImageFormatDto[];
}
