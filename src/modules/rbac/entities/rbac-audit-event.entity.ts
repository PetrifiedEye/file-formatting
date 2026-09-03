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

export enum RbacAuditEventType {
  ROLE_CREATED = 'role_created',
  ROLE_UPDATED = 'role_updated',
  ROLE_DELETED = 'role_deleted',
  PERMISSION_CREATED = 'permission_created',
  PERMISSION_UPDATED = 'permission_updated',
  PERMISSION_DELETED = 'permission_deleted',
  GRANT_CREATED = 'grant_created',
  GRANT_UPDATED = 'grant_updated',
  GRANT_DELETED = 'grant_deleted',
  CONFIG_RELOADED = 'config_reloaded',
  CONFIG_RELOAD_FAILED = 'config_reload_failed',
  MANAGEMENT_ACCESS_DENIED = 'management_access_denied',
}

export enum RbacAuditOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

export enum RbacAuditEntityType {
  ROLE = 'role',
  PERMISSION = 'permission',
  GRANT = 'grant',
  CONFIG = 'config',
}

@Entity('rbac_audit_events')
@Index('idx_rbac_audit_event_created', ['eventType', 'createdAt'])
@Index('idx_rbac_audit_actor', ['actorUserId'])
export class RbacAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_type', type: 'enum', enum: RbacAuditEventType })
  eventType!: RbacAuditEventType;

  @Column({ type: 'enum', enum: RbacAuditOutcome })
  outcome!: RbacAuditOutcome;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser!: User | null;

  @Column({
    name: 'entity_type',
    type: 'enum',
    enum: RbacAuditEntityType,
    nullable: true,
  })
  entityType!: RbacAuditEntityType | null;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
