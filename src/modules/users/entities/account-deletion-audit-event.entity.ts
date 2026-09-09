import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AccountDeletionAuditAction {
  SELF_DELETE_INITIATED = 'self_delete_initiated',
  SELF_DELETE_RESENT = 'self_delete_resent',
  SELF_DELETE_CONFIRMED = 'self_delete_confirmed',
  SELF_DELETE_FAILED = 'self_delete_failed',
  ADMIN_DELETE = 'admin_delete',
}

export enum AccountDeletionAuditOutcome {
  SUCCESS = 'success',
  DENIED = 'denied',
  FAILURE = 'failure',
  NOT_FOUND = 'not_found',
  CONFLICT = 'conflict',
}

@Entity('account_deletion_audit_events')
@Index('idx_account_deletion_audit_actor_created', ['actorId', 'createdAt'])
export class AccountDeletionAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ name: 'target_id', type: 'varchar' })
  targetId!: string;

  @Column({
    type: 'enum',
    enum: AccountDeletionAuditAction,
  })
  action!: AccountDeletionAuditAction;

  @Column({
    type: 'enum',
    enum: AccountDeletionAuditOutcome,
  })
  outcome!: AccountDeletionAuditOutcome;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
