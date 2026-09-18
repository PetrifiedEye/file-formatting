import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { ConversionFileStorageService } from '@/core/storage/conversion-file-storage.service';
import { TransformationResultAuditService } from '@/modules/transformation-result-storage/transformation-result-audit.service';
import {
  TransformationResultAuditAction,
  TransformationResultAuditOutcome,
} from '@/modules/transformation-result-storage/transformation-result.enums';

import { ConversionRetentionOutcome, RecordedFormat } from './conversion.enums';
import { ConversionRecord } from './entities/conversion-record.entity';
import { ConversionStoredFile } from './entities/conversion-stored-file.entity';

export interface RetentionRequest {
  userId: string;
  format: RecordedFormat;
  extension: string;
  buffer: Buffer;
}

export interface RetentionFinalizationRequest {
  userId: string;
  conversionRecordId: string | null;
  retentionRequested: boolean;
  /**
   * A successful conversion result. `null` means the conversion failed before
   * a retainable result existed.
   */
  result: RetentionRequest | null;
  /** The applicable document/image output limit. */
  maxSizeBytes: number;
}

export interface RetentionFinalizationResult {
  retentionOutcome: ConversionRetentionOutcome;
  storedFileId: string | null;
  /** Null only when retention was not requested and therefore no save existed. */
  auditOutcome: TransformationResultAuditOutcome | null;
}

/** A result already on disk, not yet attached to its conversion. */
export interface StoredFile {
  id: string;
  userId: string;
  format: RecordedFormat;
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
    private readonly audit: TransformationResultAuditService,
  ) {}

  /**
   * Finalize one recognized save intent after its history row was attempted.
   *
   * This is the only save orchestration used by either conversion family:
   * validate the family-specific output bound, write privately, attach in one
   * database transaction, compensate an attach failure, and write exactly one
   * best-effort audit event. No failure escapes to replace conversion output.
   */
  async finalize(
    request: RetentionFinalizationRequest,
  ): Promise<RetentionFinalizationResult> {
    if (!request.retentionRequested) {
      return {
        retentionOutcome: ConversionRetentionOutcome.NOT_REQUESTED,
        storedFileId: null,
        auditOutcome: null,
      };
    }

    const startedMs = Date.now();
    const fileSizeBytes = request.result?.buffer.length ?? null;
    let retentionOutcome = ConversionRetentionOutcome.FAILED;
    let storedFileId: string | null = null;
    let auditOutcome: TransformationResultAuditOutcome;

    if (request.result === null) {
      auditOutcome = TransformationResultAuditOutcome.CONVERSION_FAILED;
    } else if (request.result.buffer.length > request.maxSizeBytes) {
      auditOutcome = TransformationResultAuditOutcome.SIZE_EXCEEDED;
    } else if (request.conversionRecordId === null) {
      // Without a history row a stored file could never be reached or cleaned.
      auditOutcome = TransformationResultAuditOutcome.HISTORY_UNAVAILABLE;
    } else {
      const stored = await this.storeSafely(request.result);

      if (stored === null) {
        auditOutcome = TransformationResultAuditOutcome.STORAGE_FAILED;
      } else {
        storedFileId = stored.id;

        if (await this.attachSafely(request.conversionRecordId, stored)) {
          retentionOutcome = ConversionRetentionOutcome.STORED;
          auditOutcome = TransformationResultAuditOutcome.SUCCESS;
        } else {
          auditOutcome = TransformationResultAuditOutcome.ATTACH_FAILED;
          await this.discardSafely(stored);
        }
      }
    }

    await this.auditSafely({
      actorUserId: request.userId,
      conversionRecordId: request.conversionRecordId,
      storedFileId,
      action: TransformationResultAuditAction.SAVE,
      outcome: auditOutcome,
      fileSizeBytes,
      durationMs: Math.max(0, Date.now() - startedMs),
    });

    return { retentionOutcome, storedFileId, auditOutcome };
  }

  private async storeSafely(
    request: RetentionRequest,
  ): Promise<StoredFile | null> {
    try {
      return await this.store(request);
    } catch (error) {
      // `store` is already non-throwing, but this boundary also contains test
      // doubles and future storage implementations that violate that contract.
      this.logger.error('Failed to store a converted result', error as Error);
      return null;
    }
  }

  private async attachSafely(
    conversionRecordId: string,
    stored: StoredFile,
  ): Promise<boolean> {
    try {
      return await this.attach(conversionRecordId, stored);
    } catch {
      return false;
    }
  }

  private async discardSafely(stored: StoredFile): Promise<void> {
    try {
      await this.discard(stored);
    } catch (error) {
      this.logger.error(
        `Failed to discard an unattached converted file ${stored.id}`,
        error as Error,
      );
    }
  }

  private async auditSafely(
    input: Parameters<TransformationResultAuditService['record']>[0],
  ): Promise<void> {
    try {
      await this.audit.record(input);
    } catch (error) {
      // The collaborator is specified as non-throwing; keep this boundary
      // defensive so an audit regression can never alter conversion output.
      this.logger.error(
        'Failed to audit conversion result retention',
        error as Error,
      );
    }
  }

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
