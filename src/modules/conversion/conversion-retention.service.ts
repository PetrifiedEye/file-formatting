import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { ConversionFileStorageService } from '@/core/storage/conversion-file-storage.service';

import {
  ConversionFormat,
  ConversionRetentionOutcome,
} from './conversion.enums';
import { ConversionRecord } from './entities/conversion-record.entity';
import { ConversionStoredFile } from './entities/conversion-stored-file.entity';

export interface RetentionRequest {
  userId: string;
  format: ConversionFormat;
  extension: string;
  buffer: Buffer;
}

/** A result already on disk, not yet attached to its conversion. */
export interface StoredFile {
  id: string;
  userId: string;
  format: ConversionFormat;
  sizeBytes: number;
  storagePath: string;
}

/**
 * Keeps a copy of a successful conversion, when the caller asked for one.
 *
 * The governing rule is FR-028: **a storage failure is not a conversion
 * failure.** The conversion did succeed, the caller is entitled to the file,
 * and withholding it because a disk write failed would be the worse lie. So
 * nothing here throws — every path reports what actually happened and lets the
 * response go out with the result and an honest header.
 */
@Injectable()
export class ConversionRetentionService {
  private readonly logger = new Logger(ConversionRetentionService.name);

  constructor(
    @InjectRepository(ConversionStoredFile)
    private readonly storedFiles: Repository<ConversionStoredFile>,
    @InjectRepository(ConversionRecord)
    private readonly records: Repository<ConversionRecord>,
    private readonly storage: ConversionFileStorageService,
  ) {}

  /**
   * Write the result to disk.
   *
   * Only ever called for a conversion that succeeded — FR-026 forbids keeping
   * anything for one that did not. Returns `null` when the write failed, which
   * the caller reports as `failed` rather than as an error.
   */
  async store(request: RetentionRequest): Promise<StoredFile | null> {
    const id = randomUUID();

    try {
      const storagePath = await this.storage.save(
        request.userId,
        id,
        request.extension,
        request.buffer,
      );

      return {
        id,
        userId: request.userId,
        format: request.format,
        sizeBytes: request.buffer.length,
        storagePath,
      };
    } catch {
      // Already logged by the storage service; nothing was written.
      return null;
    }
  }

  /**
   * Attach a stored file to the conversion that produced it.
   *
   * Two statements rather than one because the two tables reference each other
   * on purpose: the record must be able to point at nothing, and the file must
   * never exist without its conversion. They run under one transaction so that
   * the schema's `retention_outcome = 'stored' ⇔ stored_file_id IS NOT NULL`
   * constraint is never momentarily false, and so a failure leaves the record
   * saying `failed` — which is the truth — rather than half-linked.
   *
   * The conversion record itself is written *before* this and outside any
   * transaction, so a rollback here can never erase the record of the attempt
   * (FR-024).
   */
  @Transactional()
  async attach(
    conversionRecordId: string,
    stored: StoredFile,
  ): Promise<boolean> {
    try {
      await this.storedFiles.insert({
        id: stored.id,
        userId: stored.userId,
        conversionRecordId,
        format: stored.format,
        sizeBytes: stored.sizeBytes,
        storagePath: stored.storagePath,
      });

      await this.records.update(
        { id: conversionRecordId },
        {
          retentionOutcome: ConversionRetentionOutcome.STORED,
          storedFileId: stored.id,
        },
      );

      return true;
    } catch (error) {
      this.logger.error(
        `Stored a converted file for user ${stored.userId} but could not record it`,
        error as Error,
      );
      throw error;
    }
  }

  /**
   * Drop a file that could not be attached.
   *
   * A file nothing points at is unreachable and unattributable — worse than no
   * file at all, and it would never be cleaned up.
   */
  async discard(stored: StoredFile): Promise<void> {
    await this.storage.delete(stored.storagePath);
  }
}
