import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import {
  ConfirmationPolicyResponseDto,
  UpdateConfirmationPolicyRequestDto,
} from './dto/confirmation-policy-response.dto';
import { AdminGuard } from './guards/admin.guard';

@ApiTags('Admin Settings')
@Controller('admin/settings')
@UseGuards(AdminGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get('confirmation-policy')
  @ApiOperation({ summary: 'Read confirmation and password policy' })
  @ApiOkResponse({ type: ConfirmationPolicyResponseDto })
  async getConfirmationPolicy(): Promise<ConfirmationPolicyResponseDto> {
    const settings = await this.settingsService.getSettings();
    return this.toResponse(settings);
  }

  @Patch('confirmation-policy')
  @ApiOperation({ summary: 'Update confirmation and password policy' })
  @ApiOkResponse({ type: ConfirmationPolicyResponseDto })
  async updateConfirmationPolicy(
    @Body() dto: UpdateConfirmationPolicyRequestDto,
  ): Promise<ConfirmationPolicyResponseDto> {
    const settings = await this.settingsService.updateConfirmationPolicy(dto);
    return this.toResponse(settings);
  }

  private toResponse(settings: {
    registrationConfirmationEnabled: boolean;
    passwordRecoveryConfirmationEnabled: boolean;
    signInConfirmationEnabled: boolean;
    passwordMinLength: number;
    passwordRequireUppercase: boolean;
    passwordRequireDigit: boolean;
    passwordRequireSpecial: boolean;
  }): ConfirmationPolicyResponseDto {
    return {
      registrationConfirmationEnabled: settings.registrationConfirmationEnabled,
      passwordRecoveryConfirmationEnabled:
        settings.passwordRecoveryConfirmationEnabled,
      signInConfirmationEnabled: settings.signInConfirmationEnabled,
      passwordMinLength: settings.passwordMinLength,
      passwordRequireUppercase: settings.passwordRequireUppercase,
      passwordRequireDigit: settings.passwordRequireDigit,
      passwordRequireSpecial: settings.passwordRequireSpecial,
    };
  }
}
