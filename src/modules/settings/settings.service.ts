import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SettingsAuditEventType,
  SettingsAuditOutcome,
  SettingsChangeSet,
} from './entities/settings-audit-event.entity';
import {
  SettingsAuditContext,
  SettingsAuditService,
} from './settings-audit.service';
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

export interface PolicyChangeActor {
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UpdateTransformationRetentionPolicyInput {
  retentionDays: number;
}

export interface TransformationRetentionPolicy {
  retentionDays: number;
}

const POLICY_FIELDS = [
  'registrationConfirmationEnabled',
  'passwordRecoveryConfirmationEnabled',
  'signInConfirmationEnabled',
  'passwordMinLength',
  'passwordRequireUppercase',
  'passwordRequireDigit',
  'passwordRequireSpecial',
] as const satisfies readonly (keyof UpdateConfirmationPolicyInput)[];

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(SystemSettings)
    private readonly settingsRepository: Repository<SystemSettings>,
    private readonly settingsAuditService: SettingsAuditService,
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

  async getTransformationRetentionPolicy(): Promise<TransformationRetentionPolicy> {
    const settings = await this.getSettings();
    return { retentionDays: settings.transformationHistoryRetentionDays };
  }

  async updateTransformationRetentionPolicy(
    input: UpdateTransformationRetentionPolicyInput,
    actor: PolicyChangeActor = {},
  ): Promise<TransformationRetentionPolicy> {
    const settings = await this.getSettings();
    const current = settings.transformationHistoryRetentionDays;
    const changes: SettingsChangeSet =
      current === input.retentionDays
        ? {}
        : {
            retentionDays: {
              from: current,
              to: input.retentionDays,
            },
          };

    settings.transformationHistoryRetentionDays = input.retentionDays;

    try {
      const saved = await this.settingsRepository.save(settings);

      await this.recordAuditBestEffort(
        SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
        SettingsAuditOutcome.SUCCESS,
        { ...actor, changes },
      );

      return { retentionDays: saved.transformationHistoryRetentionDays };
    } catch (error) {
      await this.recordAuditBestEffort(
        SettingsAuditEventType.TRANSFORMATION_RETENTION_UPDATED,
        SettingsAuditOutcome.FAILURE,
        {
          ...actor,
          changes,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
      );

      throw error;
    }
  }

  async updateConfirmationPolicy(
    input: UpdateConfirmationPolicyInput,
    actor: PolicyChangeActor = {},
  ): Promise<SystemSettings> {
    const settings = await this.getSettings();
    const changes: SettingsChangeSet = {};

    for (const field of POLICY_FIELDS) {
      const next = input[field];
      if (next === undefined) {
        continue;
      }

      const current = settings[field];
      if (current === next) {
        continue;
      }

      changes[field] = { from: current, to: next };
      // Assigned through `Object.assign` because a direct `settings[field] =`
      // over a union of keys narrows the target type to `never`.
      Object.assign(settings, { [field]: next });
    }

    try {
      const saved = await this.settingsRepository.save(settings);

      await this.settingsAuditService.record(
        SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
        SettingsAuditOutcome.SUCCESS,
        { ...actor, changes },
      );

      return saved;
    } catch (error) {
      await this.settingsAuditService.record(
        SettingsAuditEventType.CONFIRMATION_POLICY_UPDATED,
        SettingsAuditOutcome.FAILURE,
        {
          ...actor,
          changes,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
      );

      throw error;
    }
  }

  private async recordAuditBestEffort(
    eventType: SettingsAuditEventType,
    outcome: SettingsAuditOutcome,
    context: SettingsAuditContext,
  ): Promise<void> {
    try {
      await this.settingsAuditService.record(eventType, outcome, context);
    } catch {
      // SettingsAuditService is deliberately non-throwing. This boundary also
      // protects policy persistence if a replacement/mock violates that
      // best-effort contract.
      return;
    }
  }
}
