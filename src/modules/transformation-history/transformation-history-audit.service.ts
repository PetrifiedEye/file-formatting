import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  TransformationHistoryAuditEvent,
  TransformationHistoryAuditOutcome,
} from './entities/transformation-history-audit-event.entity';

export interface TransformationHistoryAuditInput {
  /** Null only on an unauthenticated request — nobody was identified. */
  actorUserId: string | null;
  targetUserId?: string | null;
  outcome: TransformationHistoryAuditOutcome;
  resultCount?: number | null;
  typeFilterUsed?: boolean;
  sourceFormatFilterUsed?: boolean;
  targetFormatFilterUsed?: boolean;
  statusFilterUsed?: boolean;
  dateRangeFilterUsed?: boolean;
}

@Injectable()
export class TransformationHistoryAuditService {
  private readonly logger = new Logger(TransformationHistoryAuditService.name);

  constructor(
    @InjectRepository(TransformationHistoryAuditEvent)
    private readonly auditRepository: Repository<TransformationHistoryAuditEvent>,
  ) {}

  /**
   * Never throws (FR-017: best-effort, non-blocking).
   *
   * A failure to record that a read happened must not turn a successful read
   * into a 500 — the caller already has a right to the data, and the operator
   * gets an error log either way.
   */
  async record(input: TransformationHistoryAuditInput): Promise<void> {
    try {
      const event = this.auditRepository.create({
        actorUserId: input.actorUserId,
        targetUserId: input.targetUserId ?? null,
        outcome: input.outcome,
        resultCount: input.resultCount ?? null,
        typeFilterUsed: input.typeFilterUsed ?? false,
        sourceFormatFilterUsed: input.sourceFormatFilterUsed ?? false,
        targetFormatFilterUsed: input.targetFormatFilterUsed ?? false,
        statusFilterUsed: input.statusFilterUsed ?? false,
        dateRangeFilterUsed: input.dateRangeFilterUsed ?? false,
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        `Failed to record a transformation history audit event for actor ${input.actorUserId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
