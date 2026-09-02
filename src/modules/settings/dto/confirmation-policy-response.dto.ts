import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

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

export class UpdateConfirmationPolicyRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  registrationConfirmationEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRecoveryConfirmationEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  signInConfirmationEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 8 })
  @IsOptional()
  @IsInt()
  @Min(8)
  passwordMinLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireUppercase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireDigit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  passwordRequireSpecial?: boolean;
}
