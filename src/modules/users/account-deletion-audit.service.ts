import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AccountDeletionAuditAction,
  AccountDeletionAuditEvent,
  AccountDeletionAuditOutcome,
} from './entities/account-deletion-audit-event.entity';

@Injectable()
export class AccountDeletionAuditService {
  private readonly logger = new Logger(AccountDeletionAuditService.name);

  constructor(
    @InjectRepository(AccountDeletionAuditEvent)
    private readonly auditRepository: Repository<AccountDeletionAuditEvent>,
  ) {}

  async record(
    actorId: string,
    targetId: string,
    action: AccountDeletionAuditAction,
    outcome: AccountDeletionAuditOutcome,
  ): Promise<void> {
    try {
      const event = this.auditRepository.create({
        actorId,
        targetId,
        action,
        outcome,
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to record account deletion audit event for actor ${actorId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
