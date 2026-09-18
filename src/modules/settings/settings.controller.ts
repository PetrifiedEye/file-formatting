import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SettingsService } from './settings.service';
import {
  ConfirmationPolicyResponseDto,
  UpdateConfirmationPolicyRequestDto,
} from './dto/confirmation-policy-response.dto';
import {
  TransformationRetentionPolicyResponseDto,
  UpdateTransformationRetentionPolicyRequestDto,
} from './dto/transformation-retention-policy.dto';
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

  @Get('transformation-retention')
  @ApiOperation({ summary: 'Read transformation history retention policy' })
  @ApiOkResponse({ type: TransformationRetentionPolicyResponseDto })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  async getTransformationRetentionPolicy(): Promise<TransformationRetentionPolicyResponseDto> {
    return this.settingsService.getTransformationRetentionPolicy();
  }

  @Patch('transformation-retention')
  @ApiOperation({ summary: 'Update transformation history retention policy' })
  @ApiOkResponse({ type: TransformationRetentionPolicyResponseDto })
  @ApiBadRequestResponse({
    description: 'retentionDays must be an integer from 1 through 3650',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Insufficient permissions' })
  async updateTransformationRetentionPolicy(
    @Body() dto: UpdateTransformationRetentionPolicyRequestDto,
    @Req() req: RequestWithActor,
  ): Promise<TransformationRetentionPolicyResponseDto> {
    return this.settingsService.updateTransformationRetentionPolicy(
      dto,
      extractActor(req),
    );
  }

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
