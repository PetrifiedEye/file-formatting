import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { ConversionFormat } from '../conversion.enums';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';
import { multipartFlagField } from '@/core/validation/joi-fields';

/**
 * Validated by hand against the multipart fields: the global pipe never sees
 * a multipart body.
 */
export const convertRequestDtoSchema = Joi.object<ConvertRequestDto>({
  targetFormat: Joi.string()
    .valid(...Object.values(ConversionFormat))
    .required(),
  store: multipartFlagField(),
});

/**
 * The non-file parts of a conversion request.
 *
 * The global `ValidationPipe` never sees a multipart body, so this DTO is
 * validated explicitly by the controller (`plainToInstance` + `validate`). It is
 * a DTO rather than a pair of `if` statements so that Swagger, the validation
 * rules, and the controller all describe the same contract.
 *
 * Both fields arrive as strings — multipart has no other type.
 */
@JoiSchema(convertRequestDtoSchema)
export class ConvertRequestDto {
  @ApiProperty({
    enum: ConversionFormat,
    description: 'The format to convert into. Must differ from the source.',
  })
  targetFormat!: ConversionFormat;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description: 'Keep the converted file in application storage.',
  })
  store?: 'true' | 'false';
}
