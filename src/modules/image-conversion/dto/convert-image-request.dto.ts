import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { ImageFormat } from '@/modules/conversion/conversion.enums';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import {
  backgroundColorField,
  multipartFlagField,
} from '@/core/validation/joi-fields';

/**
 * Validated by hand against the multipart fields: the global pipe never sees
 * a multipart body.
 */
export const convertImageRequestDtoSchema = Joi.object<ConvertImageRequestDto>({
  targetFormat: Joi.string()
    .valid(...Object.values(ImageFormat))
    .required(),
  store: multipartFlagField(),
  backgroundColor: backgroundColorField(),
});

/**
 * The non-file parts of a conversion request.
 *
 * Applied by `ImageUploadPipe` rather than by the global validation pipe,
 * which never sees a multipart body — a DTO that is silently skipped is worse
 * than no DTO. Its keys are also the field whitelist.
 *
 * Multipart fields arrive as strings, hence `store` being `'true'`/`'false'`
 * rather than a boolean: coercing here would turn every unrecognised value
 * into `false` and lose the `invalid_store_flag` refusal.
 */
@JoiSchema(convertImageRequestDtoSchema)
export class ConvertImageRequestDto {
  @ApiProperty({
    enum: ImageFormat,
    description:
      'The format to produce. `svg` is a real format and an accepted ' +
      'value, but no direction produces it, so it is always refused.',
  })
  targetFormat!: ImageFormat;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description: 'Keep the converted image in application storage.',
  })
  store?: 'true' | 'false';

  @ApiPropertyOptional({
    example: '#ffffff',
    default: 'transparent',
    description:
      'What transparent pixels are composited onto: `transparent`, ' +
      '`#rrggbb` or `#rrggbbaa`. Defaults to `IMAGE_BACKGROUND_COLOR` ' +
      '(`transparent`). JPEG cannot be transparent, so for a JPEG target ' +
      'the colour is itself composited onto white.',
  })
  backgroundColor?: string;
}
