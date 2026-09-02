import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';

import {
  RegistrationAuditEvent,
  RegistrationAuditEventType,
  RegistrationAuditOutcome,
} from './entities/registration-audit-event.entity';

export interface AuditContext {
  normalizedEmail: string;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class RegistrationAuditService {
  private readonly logger = new Logger(RegistrationAuditService.name);

  constructor(
    @InjectRepository(RegistrationAuditEvent)
    private readonly auditRepository: Repository<RegistrationAuditEvent>,
  ) {}

  async record(
    eventType: RegistrationAuditEventType,
    outcome: RegistrationAuditOutcome,
    context: AuditContext,
  ): Promise<void> {
    const userAgent = context.userAgent?.slice(0, 512) ?? null;

    const event = this.auditRepository.create({
      eventType,
      outcome,
      normalizedEmail: context.normalizedEmail,
      userId: context.userId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent,
      failureReason: context.failureReason ?? null,
      metadata: context.metadata ?? {},
    });

    await this.auditRepository.save(event);

    this.logger.log(
      `${eventType} ${outcome} for ${context.normalizedEmail}${
        context.failureReason ? ` (${context.failureReason})` : ''
      }`,
    );
  }

  async countConfirmationEmailsSince(
    normalizedEmail: string,
    since: Date,
  ): Promise<number> {
    return this.auditRepository.count({
      where: {
        normalizedEmail,
        eventType: RegistrationAuditEventType.CONFIRMATION_EMAIL_SENT,
        outcome: RegistrationAuditOutcome.SUCCESS,
        createdAt: MoreThan(since),
      },
    });
  }
}
