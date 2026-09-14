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

export enum SessionRevocationReason {
  LOGOUT = 'logout',
  PASSWORD_RESET = 'password_reset',
}

/**
 * The server-side half of a sign-in. Access and refresh tokens both carry this
 * row's id (`sid`), which makes them revocable: without it a stolen 30-day
 * refresh token stayed valid through both logout and a password reset.
 */
@Entity('auth_sessions')
@Index('idx_auth_sessions_user', ['userId'])
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz' })
  lastUsedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    name: 'revoked_reason',
    type: 'enum',
    enum: SessionRevocationReason,
    nullable: true,
  })
  revokedReason!: SessionRevocationReason | null;
}
