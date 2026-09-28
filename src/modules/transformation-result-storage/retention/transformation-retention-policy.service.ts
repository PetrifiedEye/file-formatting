import { Injectable } from '@nestjs/common';

import { SettingsService } from '@/modules/settings/settings.service';

@Injectable()
export class TransformationRetentionPolicyService {
  constructor(private readonly settingsService: SettingsService) {}

  async getRetentionDays(): Promise<number> {
    const policy =
      await this.settingsService.getTransformationRetentionPolicy();

    return policy.retentionDays;
  }

  async calculateExpiresAt(createdAt: Date): Promise<Date> {
    const retentionDays = await this.getRetentionDays();
    return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  }
}
