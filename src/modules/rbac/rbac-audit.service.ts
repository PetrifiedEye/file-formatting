import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  RbacAuditEntityType,
  RbacAuditEvent,
  RbacAuditEventType,
  RbacAuditOutcome,
} from './entities/rbac-audit-event.entity';

export interface RbacAuditContext {
  actorUserId?: string | null;
  entityType?: RbacAuditEntityType | null;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class RbacAuditService {
  private readonly logger = new Logger(RbacAuditService.name);

  constructor(
    @InjectRepository(RbacAuditEvent)
    private readonly auditRepository: Repository<RbacAuditEvent>,
  ) {}

  async record(
    eventType: RbacAuditEventType,
    outcome: RbacAuditOutcome,
    context: RbacAuditContext = {},
  ): Promise<void> {
    const event = this.auditRepository.create({
      eventType,
      outcome,
      actorUserId: context.actorUserId ?? null,
      entityType: context.entityType ?? null,
      entityId: context.entityId ?? null,
      reason: context.reason ?? null,
      metadata: context.metadata ?? {},
    });

    await this.auditRepository.save(event);

    this.logger.log(
      `${eventType} ${outcome}${
        context.entityId ? ` for ${context.entityType} ${context.entityId}` : ''
      }${context.reason ? ` (${context.reason})` : ''}`,
    );
  }
}
