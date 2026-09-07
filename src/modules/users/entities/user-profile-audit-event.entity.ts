import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum UserProfileAuditOutcome {
  SELF_VIEW = 'self_view',
  PRIVILEGED_VIEW = 'privileged_view',
  DENIED = 'denied',
  NOT_FOUND = 'not_found',
}

@Entity('user_profile_audit_events')
@Index('idx_user_profile_audit_viewer_created', ['viewerId', 'createdAt'])
export class UserProfileAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'viewer_id', type: 'uuid' })
  viewerId!: string;

  @Column({ name: 'target_id', type: 'varchar' })
  targetId!: string;

  @Column({
    type: 'enum',
    enum: UserProfileAuditOutcome,
  })
  outcome!: UserProfileAuditOutcome;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
