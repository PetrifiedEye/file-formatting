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

export enum LoginAuditEventType {
  LOGIN_ATTEMPT = 'login_attempt',
  LOGIN_VERIFICATION_ATTEMPT = 'login_verification_attempt',
  LOGOUT = 'logout',
  PASSWORD_RESET_REQUESTED = 'password_reset_requested',
  PASSWORD_RESET_ATTEMPT = 'password_reset_attempt',
  ACCESS_CHECK_FAILED = 'access_check_failed',
  TOKEN_REFRESH_ATTEMPT = 'token_refresh_attempt',
}

export enum LoginAuditOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
  LOCKED_OUT = 'locked_out',
}

@Entity('login_audit_events')
@Index('idx_login_audit_email_created', ['normalizedEmail', 'createdAt'])
@Index('idx_login_audit_event_created', ['eventType', 'createdAt'])
export class LoginAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: LoginAuditEventType,
  })
  eventType!: LoginAuditEventType;

  @Column({
    type: 'enum',
    enum: LoginAuditOutcome,
  })
  outcome!: LoginAuditOutcome;

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
