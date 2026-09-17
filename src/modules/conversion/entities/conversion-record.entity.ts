import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import {
  ConversionErrorCategory,
  ConversionOutcome,
  ConversionRetentionOutcome,
  RecordedFormat,
} from '../conversion.enums';
import { ConversionStoredFile } from './conversion-stored-file.entity';

/**
 * One row per authenticated conversion attempt, successful or not (FR-021).
 *
 * **No column here can hold file content.** That is the mechanism behind FR-023
 * and SC-005: the guarantee comes from the shape of the table, not from
 * discipline at each call site. `original_file_name` is a name; `failure_reason`
 * is a fixed code plus a position.
 */
@Entity('conversion_records')
// The access path for "this user's history" — the read feature that follows,
// and the SC-004 verification query.
@Index('idx_conversion_records_user_started', ['userId', 'startedAt'])
// Operational queries: failure rates and recent failures.
@Index('idx_conversion_records_outcome_started', ['outcome', 'startedAt'])
export class ConversionRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /**
   * Cascades with the account. This is the user's own history, not a security
   * audit trail — unlike `*_audit_events`, which deliberately omit the FK so
   * they outlive the account they describe.
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'original_file_name', type: 'varchar', length: 255 })
  originalFileName!: string;

  /**
   * Nullable: detection may fail before any format is known.
   *
   * `RecordedFormat` rather than `ConversionFormat`: the column holds both
   * families, and the value itself is what says which one an attempt belongs
   * to — which is why there is no discriminator column (feature 011).
   */
  @Column({
    name: 'source_format',
    type: 'enum',
    enum: RecordedFormat,
    enumName: 'conversion_format',
    nullable: true,
  })
  sourceFormat!: RecordedFormat | null;

  /** Nullable: the request may name a format we do not support. */
  @Column({
    name: 'target_format',
    type: 'enum',
    enum: RecordedFormat,
    enumName: 'conversion_format',
    nullable: true,
  })
  targetFormat!: RecordedFormat | null;

  /**
   * Bytes actually received. For a 413 this is where the budget was exceeded,
   * not the true file size — the rest is never read (SC-006).
   */
  @Column({ name: 'input_size_bytes', type: 'bigint' })
  inputSizeBytes!: string;

  @Column({ name: 'output_size_bytes', type: 'integer', nullable: true })
  outputSizeBytes!: number | null;

  @Column({
    type: 'enum',
    enum: ConversionOutcome,
    enumName: 'conversion_outcome',
  })
  outcome!: ConversionOutcome;

  @Column({
    name: 'error_category',
    type: 'enum',
    enum: ConversionErrorCategory,
    enumName: 'conversion_error_category',
    nullable: true,
  })
  errorCategory!: ConversionErrorCategory | null;

  /** A fixed code plus an optional position. **Never a library message.** */
  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ name: 'retention_requested', type: 'boolean', default: false })
  retentionRequested!: boolean;

  /** What actually happened, which is not always what was asked for (FR-028). */
  @Column({
    name: 'retention_outcome',
    type: 'enum',
    enum: ConversionRetentionOutcome,
    enumName: 'conversion_retention_outcome',
    default: ConversionRetentionOutcome.NOT_REQUESTED,
  })
  retentionOutcome!: ConversionRetentionOutcome;

  @Column({ name: 'stored_file_id', type: 'uuid', nullable: true })
  storedFileId!: string | null;

  @OneToOne(() => ConversionStoredFile, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'stored_file_id' })
  storedFile!: ConversionStoredFile | null;

  @Column({ name: 'started_at', type: 'timestamptz', precision: 3 })
  startedAt!: Date;

  /** Wall-clock, including the time a failed attempt spent failing. */
  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
