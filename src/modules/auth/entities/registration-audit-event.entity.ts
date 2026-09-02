import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

export enum RegistrationAuditEventType {
  REGISTRATION_ATTEMPT = 'registration_attempt',
  CONFIRMATION_EMAIL_SENT = 'confirmation_email_sent',
  CONFIRMATION_ATTEMPT = 'confirmation_attempt',
}

export enum RegistrationAuditOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

@Entity('registration_audit_events')
@Index('idx_registration_audit_email_created', ['normalizedEmail', 'createdAt'])
@Index('idx_registration_audit_event_created', ['eventType', 'createdAt'])
export class RegistrationAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: RegistrationAuditEventType,
  })
  eventType!: RegistrationAuditEventType;

  @Column({
    type: 'enum',
    enum: RegistrationAuditOutcome,
  })
  outcome!: RegistrationAuditOutcome;

  @Column({ name: 'normalized_email', type: 'citext' })
  normalizedEmail!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
