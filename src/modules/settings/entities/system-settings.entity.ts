import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('system_settings')
export class SystemSettings {
  @PrimaryColumn({ type: 'smallint' })
  id!: number;

  @Column({
    name: 'registration_confirmation_enabled',
    type: 'boolean',
    default: false,
  })
  registrationConfirmationEnabled!: boolean;

  @Column({
    name: 'password_recovery_confirmation_enabled',
    type: 'boolean',
    default: false,
  })
  passwordRecoveryConfirmationEnabled!: boolean;

  @Column({
    name: 'sign_in_confirmation_enabled',
    type: 'boolean',
    default: false,
  })
  signInConfirmationEnabled!: boolean;

  @Column({ name: 'password_min_length', type: 'smallint', default: 8 })
  passwordMinLength!: number;

  @Column({
    name: 'password_require_uppercase',
    type: 'boolean',
    default: false,
  })
  passwordRequireUppercase!: boolean;

  @Column({ name: 'password_require_digit', type: 'boolean', default: false })
  passwordRequireDigit!: boolean;

  @Column({ name: 'password_require_special', type: 'boolean', default: false })
  passwordRequireSpecial!: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
