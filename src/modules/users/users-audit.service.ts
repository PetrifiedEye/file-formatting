import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  UserProfileAuditEvent,
  UserProfileAuditOutcome,
} from './entities/user-profile-audit-event.entity';

@Injectable()
export class UsersAuditService {
  private readonly logger = new Logger(UsersAuditService.name);

  constructor(
    @InjectRepository(UserProfileAuditEvent)
    private readonly auditRepository: Repository<UserProfileAuditEvent>,
  ) {}

  async record(
    viewerId: string,
    targetId: string,
    outcome: UserProfileAuditOutcome,
  ): Promise<void> {
    try {
      const event = this.auditRepository.create({
        viewerId,
        targetId,
        outcome,
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to record profile audit event for viewer ${viewerId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
