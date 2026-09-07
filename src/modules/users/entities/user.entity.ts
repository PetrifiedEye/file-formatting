import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserStatus {
  PENDING_CONFIRMATION = 'pending_confirmation',
  ACTIVE = 'active',
}

@Entity('users')
@Index('idx_users_pending', ['status'], {
  where: `"status" = 'pending_confirmation'`,
})
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'citext', unique: true })
  email!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.PENDING_CONFIRMATION,
  })
  status!: UserStatus;

  @Column({ name: 'pending_expires_at', type: 'timestamptz', nullable: true })
  pendingExpiresAt!: Date | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({
    name: 'failed_login_attempts',
    type: 'smallint',
    default: 0,
  })
  failedLoginAttempts!: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'photo_url', type: 'varchar', nullable: true })
  photoUrl!: string | null;
}
