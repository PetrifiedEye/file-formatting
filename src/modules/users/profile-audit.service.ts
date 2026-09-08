import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ProfileAuditAction,
  ProfileAuditEvent,
  ProfileAuditOutcome,
} from './entities/profile-audit-event.entity';

@Injectable()
export class ProfileAuditService {
  private readonly logger = new Logger(ProfileAuditService.name);

  constructor(
    @InjectRepository(ProfileAuditEvent)
    private readonly auditRepository: Repository<ProfileAuditEvent>,
  ) {}

  async record(
    actorId: string,
    targetId: string,
    action: ProfileAuditAction,
    outcome: ProfileAuditOutcome,
    fields: string[],
  ): Promise<void> {
    try {
      const event = this.auditRepository.create({
        actorId,
        targetId,
        action,
        outcome,
        fields,
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to record profile audit event for actor ${actorId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
