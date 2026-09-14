import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import {
  ConfirmationPolicyResponseDto,
  UpdateConfirmationPolicyRequestDto,
} from './dto/confirmation-policy-response.dto';
import { AdminGuard } from './guards/admin.guard';

interface RequestWithActor {
  user?: { id: string };
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

function extractActor(req: RequestWithActor) {
  const rawAgent = req.headers['user-agent'];

  return {
    actorUserId: req.user?.id ?? null,
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(rawAgent) ? rawAgent[0] : (rawAgent ?? null),
  };
}

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
    @Req() req: RequestWithActor,
  ): Promise<ConfirmationPolicyResponseDto> {
    const settings = await this.settingsService.updateConfirmationPolicy(
      dto,
      extractActor(req),
    );
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
