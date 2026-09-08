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

@Entity('email_change_challenges')
@Index('idx_email_change_challenges_active', ['userId'], {
  where: `"invalidated_at" IS NULL AND "consumed_at" IS NULL`,
})
export class EmailChangeChallenge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'new_email', type: 'citext' })
  newEmail!: string;

  @Column({ name: 'otp_hash', type: 'varchar', length: 64 })
  otpHash!: string;

  @Index('idx_email_change_challenges_link_token_hash')
  @Column({ name: 'link_token_hash', type: 'varchar', length: 64 })
  linkTokenHash!: string;

  @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'now()' })
  issuedAt!: Date;

  @Column({ name: 'last_sent_at', type: 'timestamptz', default: () => 'now()' })
  lastSentAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'attempts_remaining', type: 'smallint', default: 5 })
  attemptsRemaining!: number;

  @Column({ name: 'invalidated_at', type: 'timestamptz', nullable: true })
  invalidatedAt!: Date | null;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
