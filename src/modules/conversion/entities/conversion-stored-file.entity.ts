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

import { RecordedFormat } from '../conversion.enums';
import { ConversionRecord } from './conversion-record.entity';

/**
 * One row per retained result (FR-025 – FR-027).
 *
 * `conversion_records.stored_file_id` and this table's `conversion_record_id`
 * are deliberately both present: the record is written on every attempt and must
 * be able to point at nothing, while a file must never exist without the
 * conversion that produced it.
 */
@Entity('conversion_stored_files')
// "My retained files", and the sweep an expiry feature would need.
@Index('idx_conversion_stored_files_user_created', ['userId', 'createdAt'])
export class ConversionStoredFile {
  /** Also the on-disk file's base name. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** The owner — the only principal permitted to read it (FR-027). */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'conversion_record_id', type: 'uuid', unique: true })
  conversionRecordId!: string;

  @OneToOne(() => ConversionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversion_record_id' })
  conversionRecord!: ConversionRecord;

  /** Either family. Only ever `png` or `jpeg` for an image row: SVG has no
   * encoder, so no SVG result can exist to retain. */
  @Column({
    type: 'enum',
    enum: RecordedFormat,
    enumName: 'conversion_format',
  })
  format!: RecordedFormat;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  /**
   * Relative to `CONVERSION_STORAGE_DIR`, as `<userId>/<id>.<ext>`.
   *
   * That root is **not** `ASSETS_DIR`: `@fastify/static` serves `ASSETS_DIR`
   * unauthenticated at `/assets/`, so anything under it is readable by anyone
   * who can guess the path. Nothing in this feature serves these files over
   * HTTP at all.
   */
  @Column({ name: 'storage_path', type: 'varchar', length: 512 })
  storagePath!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
