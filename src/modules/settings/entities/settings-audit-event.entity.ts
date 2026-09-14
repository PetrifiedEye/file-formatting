import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum SettingsAuditEventType {
  CONFIRMATION_POLICY_UPDATED = 'confirmation_policy_updated',
}

export enum SettingsAuditOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

/** `{ fieldName: { from, to } }` for every field the request actually changed. */
export type SettingsChangeSet = Record<
  string,
  { from: boolean | number | null; to: boolean | number | null }
>;

@Entity('settings_audit_events')
@Index('idx_settings_audit_event_created', ['eventType', 'createdAt'])
@Index('idx_settings_audit_actor', ['actorUserId'])
export class SettingsAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_type', type: 'enum', enum: SettingsAuditEventType })
  eventType!: SettingsAuditEventType;

  @Column({ type: 'enum', enum: SettingsAuditOutcome })
  outcome!: SettingsAuditOutcome;

  // Deliberately not a FK relation: the audit trail must survive the actor's
  // account being deleted.
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'jsonb', default: {} })
  changes!: SettingsChangeSet;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 512, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
