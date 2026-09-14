import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

@Entity('grants')
@Index('idx_grants_role_permission', ['roleId', 'permissionId'], {
  unique: true,
})
export class Grant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id' })
  role!: Role;

  @Column({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  @ManyToOne(() => Permission, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'permission_id' })
  permission!: Permission;

  /**
   * Exactly the actions this grant allows. Never null and never empty: an
   * open-ended list used to mean "all actions", which turned widening a
   * permission into a silent escalation of every grant referencing it.
   */
  @Column({ type: 'text', array: true })
  actions!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
