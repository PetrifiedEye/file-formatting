import { ApiPropertyOptional } from '@nestjs/swagger';
import Joi from 'joi';

import { JoiSchema } from '@/core/validation/joi-schema.decorator';

export class ConfirmationPolicyResponseDto {
  @ApiPropertyOptional()
  registrationConfirmationEnabled!: boolean;

  @ApiPropertyOptional()
  passwordRecoveryConfirmationEnabled!: boolean;

  @ApiPropertyOptional()
  signInConfirmationEnabled!: boolean;

  @ApiPropertyOptional({ minimum: 8 })
  passwordMinLength!: number;

  @ApiPropertyOptional()
  passwordRequireUppercase!: boolean;

  @ApiPropertyOptional()
  passwordRequireDigit!: boolean;

  @ApiPropertyOptional()
  passwordRequireSpecial!: boolean;
}

const updateConfirmationPolicyRequestDtoSchema =
  Joi.object<UpdateConfirmationPolicyRequestDto>({
    registrationConfirmationEnabled: Joi.boolean().strict(),
    passwordRecoveryConfirmationEnabled: Joi.boolean().strict(),
    signInConfirmationEnabled: Joi.boolean().strict(),
    passwordMinLength: Joi.number().strict().integer().min(8),
    passwordRequireUppercase: Joi.boolean().strict(),
    passwordRequireDigit: Joi.boolean().strict(),
    passwordRequireSpecial: Joi.boolean().strict(),
  });

@JoiSchema(updateConfirmationPolicyRequestDtoSchema)
export class UpdateConfirmationPolicyRequestDto {
  @ApiPropertyOptional()
  registrationConfirmationEnabled?: boolean;

  @ApiPropertyOptional()
  passwordRecoveryConfirmationEnabled?: boolean;

  @ApiPropertyOptional()
  signInConfirmationEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 8 })
  passwordMinLength?: number;

  @ApiPropertyOptional()
  passwordRequireUppercase?: boolean;

  @ApiPropertyOptional()
  passwordRequireDigit?: boolean;

  @ApiPropertyOptional()
  passwordRequireSpecial?: boolean;
}
