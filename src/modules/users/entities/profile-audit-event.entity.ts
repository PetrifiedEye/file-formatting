import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ProfileAuditAction {
  PROFILE_UPDATE = 'profile_update',
  EMAIL_CHANGE_INITIATED = 'email_change_initiated',
  EMAIL_CHANGE_SENT = 'email_change_sent',
  EMAIL_CHANGE_RESENT = 'email_change_resent',
  EMAIL_CHANGE_CONFIRMED = 'email_change_confirmed',
  EMAIL_CHANGE_FAILED = 'email_change_failed',
  EMAIL_CHANGE_EXPIRED = 'email_change_expired',
  ADMIN_EMAIL_UPDATE = 'admin_email_update',
}

export enum ProfileAuditOutcome {
  SUCCESS = 'success',
  DENIED = 'denied',
  FAILURE = 'failure',
  NOT_FOUND = 'not_found',
}

@Entity('profile_audit_events')
@Index('idx_profile_audit_actor_created', ['actorId', 'createdAt'])
export class ProfileAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ name: 'target_id', type: 'varchar' })
  targetId!: string;

  @Column({
    type: 'enum',
    enum: ProfileAuditAction,
  })
  action!: ProfileAuditAction;

  @Column({
    type: 'enum',
    enum: ProfileAuditOutcome,
  })
  outcome!: ProfileAuditOutcome;

  @Column({ type: 'text', array: true })
  fields!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
