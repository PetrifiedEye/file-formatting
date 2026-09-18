import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from '../transformation-result.enums';

@Entity('transformation_result_audit_events')
@Index('idx_transformation_result_audit_actor_created', [
  'actorUserId',
  'createdAt',
])
@Index('idx_transformation_result_audit_target_created', [
  'targetUserId',
  'createdAt',
])
@Index('idx_transformation_result_audit_record_created', [
  'conversionRecordId',
  'createdAt',
])
export class TransformationResultAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @Column({ name: 'conversion_record_id', type: 'uuid', nullable: true })
  conversionRecordId!: string | null;

  @Column({ name: 'stored_file_id', type: 'uuid', nullable: true })
  storedFileId!: string | null;

  @Column({
    type: 'enum',
    enum: TransformationResultAuditAction,
    enumName: 'transformation_result_audit_action',
  })
  action!: TransformationResultAuditAction;

  @Column({
    type: 'enum',
    enum: TransformationResultAuditOutcome,
    enumName: 'transformation_result_audit_outcome',
  })
  outcome!: TransformationResultAuditOutcome;

  @Column({ name: 'file_size_bytes', type: 'integer', nullable: true })
  fileSizeBytes!: number | null;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
