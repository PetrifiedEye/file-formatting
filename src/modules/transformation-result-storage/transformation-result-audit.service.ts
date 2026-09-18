import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransformationResultAuditEvent } from './entities/transformation-result-audit-event.entity';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from './transformation-result.enums';

export interface TransformationResultAuditInput {
  actorUserId?: string | null;
  targetUserId?: string | null;
  conversionRecordId?: string | null;
  storedFileId?: string | null;
  action: TransformationResultAuditAction;
  outcome: TransformationResultAuditOutcome;
  fileSizeBytes?: number | null;
  durationMs: number;
}

@Injectable()
export class TransformationResultAuditService {
  private readonly logger = new Logger(TransformationResultAuditService.name);

  constructor(
    @InjectRepository(TransformationResultAuditEvent)
    private readonly auditRepository: Repository<TransformationResultAuditEvent>,
  ) {}

  async record(input: TransformationResultAuditInput): Promise<void> {
    try {
      const event = this.auditRepository.create({
        actorUserId: input.actorUserId ?? null,
        targetUserId: input.targetUserId ?? null,
        conversionRecordId: input.conversionRecordId ?? null,
        storedFileId: input.storedFileId ?? null,
        action: input.action,
        outcome: input.outcome,
        fileSizeBytes: input.fileSizeBytes ?? null,
        durationMs: Math.max(0, Math.floor(input.durationMs)),
      });

      await this.auditRepository.save(event);
    } catch (error) {
      this.logger.error(
        'Failed to record a transformation result audit event',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
