import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SystemSettings } from './entities/system-settings.entity';

export interface UpdateConfirmationPolicyInput {
  registrationConfirmationEnabled?: boolean;
  passwordRecoveryConfirmationEnabled?: boolean;
  signInConfirmationEnabled?: boolean;
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireDigit?: boolean;
  passwordRequireSpecial?: boolean;
}

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SystemSettings)
    private readonly settingsRepository: Repository<SystemSettings>,
  ) {}

  async getSettings(): Promise<SystemSettings> {
    const settings = await this.settingsRepository.findOne({
      where: { id: 1 },
    });

    if (!settings) {
      throw new Error('System settings row not found');
    }

    return settings;
  }

  async updateConfirmationPolicy(
    input: UpdateConfirmationPolicyInput,
  ): Promise<SystemSettings> {
    const settings = await this.getSettings();

    if (input.registrationConfirmationEnabled !== undefined) {
      settings.registrationConfirmationEnabled =
        input.registrationConfirmationEnabled;
    }
    if (input.passwordRecoveryConfirmationEnabled !== undefined) {
      settings.passwordRecoveryConfirmationEnabled =
        input.passwordRecoveryConfirmationEnabled;
    }
    if (input.signInConfirmationEnabled !== undefined) {
      settings.signInConfirmationEnabled = input.signInConfirmationEnabled;
    }
    if (input.passwordMinLength !== undefined) {
      settings.passwordMinLength = input.passwordMinLength;
    }
    if (input.passwordRequireUppercase !== undefined) {
      settings.passwordRequireUppercase = input.passwordRequireUppercase;
    }
    if (input.passwordRequireDigit !== undefined) {
      settings.passwordRequireDigit = input.passwordRequireDigit;
    }
    if (input.passwordRequireSpecial !== undefined) {
      settings.passwordRequireSpecial = input.passwordRequireSpecial;
    }

    return this.settingsRepository.save(settings);
  }
}
