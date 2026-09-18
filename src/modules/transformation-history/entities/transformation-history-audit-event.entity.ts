import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum TransformationHistoryAuditOutcome {
  SUCCESS = 'success',
  DENIED = 'denied',
  NOT_FOUND = 'not_found',
  UNAUTHENTICATED = 'unauthenticated',
  INVALID = 'invalid',
  RATE_LIMITED = 'rate_limited',
}

/**
 * One row per request to either history route, on every outcome (FR-017).
 *
 * FR-018 is satisfied by the shape of this table rather than by care at the
 * call sites: there is no column a file name, a pixel, a parser message or a
 * filter *value* could be written to. Which filters were used is five booleans;
 * what they were set to is not recorded at all — knowing an admin filtered by
 * source format is oversight, knowing they searched for `payroll` is not.
 *
 * No FK to `users`, matching the other `*_audit_events` tables: an access
 * record must outlive the account it describes.
 */
@Entity('transformation_history_audit_events')
@Index('idx_transformation_history_audit_actor_created', [
  'actorUserId',
  'createdAt',
])
@Index('idx_transformation_history_audit_target_created', [
  'targetUserId',
  'createdAt',
])
export class TransformationHistoryAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Null only on an unauthenticated request, which is audited too (FR-017)
   * and by definition names no caller.
   */
  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  /** Null on the self route — there is no third party to name. */
  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @Column({
    type: 'enum',
    enum: TransformationHistoryAuditOutcome,
    enumName: 'transformation_history_audit_outcome',
  })
  outcome!: TransformationHistoryAuditOutcome;

  /** How many records were disclosed. Populated only on a success. */
  @Column({ name: 'result_count', type: 'integer', nullable: true })
  resultCount!: number | null;

  @Column({ name: 'type_filter_used', type: 'boolean', default: false })
  typeFilterUsed!: boolean;

  @Column({
    name: 'source_format_filter_used',
    type: 'boolean',
    default: false,
  })
  sourceFormatFilterUsed!: boolean;

  @Column({
    name: 'target_format_filter_used',
    type: 'boolean',
    default: false,
  })
  targetFormatFilterUsed!: boolean;

  @Column({ name: 'status_filter_used', type: 'boolean', default: false })
  statusFilterUsed!: boolean;

  @Column({ name: 'date_range_filter_used', type: 'boolean', default: false })
  dateRangeFilterUsed!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
