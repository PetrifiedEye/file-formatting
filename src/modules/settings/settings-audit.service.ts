import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SettingsAuditEvent,
  SettingsAuditEventType,
  SettingsAuditOutcome,
  SettingsChangeSet,
} from './entities/settings-audit-event.entity';

export interface SettingsAuditContext {
  actorUserId?: string | null;
  changes?: SettingsChangeSet;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class SettingsAuditService {
  private readonly logger = new Logger(SettingsAuditService.name);

  constructor(
    @InjectRepository(SettingsAuditEvent)
    private readonly auditRepository: Repository<SettingsAuditEvent>,
  ) {}

  async record(
    eventType: SettingsAuditEventType,
    outcome: SettingsAuditOutcome,
    context: SettingsAuditContext = {},
  ): Promise<void> {
    // Matches the other audit services: a lost audit row must not turn a
    // completed policy change into a 500 for the caller.
    try {
      await this.auditRepository.save(
        this.auditRepository.create({
          eventType,
          outcome,
          actorUserId: context.actorUserId ?? null,
          changes: context.changes ?? {},
          reason: context.reason ?? null,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record settings audit event ${eventType}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
