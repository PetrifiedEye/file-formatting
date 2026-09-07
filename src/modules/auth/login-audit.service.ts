import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  LoginAuditEvent,
  LoginAuditEventType,
  LoginAuditOutcome,
} from './entities/login-audit-event.entity';

export interface LoginAuditContext {
  normalizedEmail: string;
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LoginAuditService {
  private readonly logger = new Logger(LoginAuditService.name);

  constructor(
    @InjectRepository(LoginAuditEvent)
    private readonly auditRepository: Repository<LoginAuditEvent>,
  ) {}

  async record(
    eventType: LoginAuditEventType,
    outcome: LoginAuditOutcome,
    context: LoginAuditContext,
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
}
