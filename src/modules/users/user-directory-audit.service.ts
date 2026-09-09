import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  UserDirectoryAuditEvent,
  UserDirectoryAuditOutcome,
} from './entities/user-directory-audit-event.entity';

export interface UserDirectoryAuditInput {
  actorId: string | null;
  outcome: UserDirectoryAuditOutcome;
  resultCount?: number | null;
  searchUsed?: boolean | null;
  statusFilterUsed?: boolean | null;
  sortField?: string | null;
}

@Injectable()
export class UserDirectoryAuditService {
  private readonly logger = new Logger(UserDirectoryAuditService.name);

  constructor(
    @InjectRepository(UserDirectoryAuditEvent)
    private readonly auditRepository: Repository<UserDirectoryAuditEvent>,
  ) {}

  async record(input: UserDirectoryAuditInput): Promise<void> {
    try {
      const event = this.auditRepository.create({
        actorId: input.actorId,
        outcome: input.outcome,
        resultCount: input.resultCount ?? null,
        searchUsed: input.searchUsed ?? null,
        statusFilterUsed: input.statusFilterUsed ?? null,
        sortField: input.sortField ?? null,
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to record user directory audit event for actor ${input.actorId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
