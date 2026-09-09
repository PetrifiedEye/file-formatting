import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum UserDirectoryAuditOutcome {
  SUCCESS = 'success',
  DENIED = 'denied',
  UNAUTHENTICATED = 'unauthenticated',
  INVALID = 'invalid',
  RATE_LIMITED = 'rate_limited',
}

@Entity('user_directory_audit_events')
@Index('idx_user_directory_audit_actor_created', ['actorId', 'createdAt'])
export class UserDirectoryAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({
    type: 'enum',
    enum: UserDirectoryAuditOutcome,
  })
  outcome!: UserDirectoryAuditOutcome;

  @Column({ name: 'result_count', type: 'integer', nullable: true })
  resultCount!: number | null;

  @Column({ name: 'search_used', type: 'boolean', nullable: true })
  searchUsed!: boolean | null;

  @Column({ name: 'status_filter_used', type: 'boolean', nullable: true })
  statusFilterUsed!: boolean | null;

  @Column({ name: 'sort_field', type: 'varchar', nullable: true })
  sortField!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
