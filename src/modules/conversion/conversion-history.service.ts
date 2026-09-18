import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ConversionErrorCategory,
  ConversionOutcome,
  ConversionRetentionOutcome,
  RecordedFormat,
  TransformationType,
} from './conversion.enums';
import { ConversionException } from './conversion.exception';
import { ConversionRecord } from './entities/conversion-record.entity';

/** Everything known about an attempt by the time it is recorded. */
export interface ConversionAttempt {
  userId: string;
  /**
   * Required, not optional and not defaulted: each caller knows its own family
   * unconditionally, and a default here would silently mislabel the other one.
   */
  transformationType: TransformationType;
  originalFileName: string;
  sourceFormat: RecordedFormat | null;
  targetFormat: RecordedFormat | null;
  inputSizeBytes: number;
  outputSizeBytes: number | null;
  retentionRequested: boolean;
  retentionOutcome: ConversionRetentionOutcome;
  storedFileId: string | null;
  startedAt: Date;
  durationMs: number;
  /** Absent on success. */
  failure?: unknown;
}

const FILE_NAME_MAX_LENGTH = 255;

/**
 * One durable row per authenticated attempt, successful or not (FR-021).
 *
 * The invariant this service exists to hold is negative: **nothing it writes
 * can contain file content.** `original_file_name` is a name, `failure_reason`
 * is a fixed code plus a position, and the table has no other free-text column
 * at all. Library parser messages — which quote the offending input — are
 * mapped to a code before they ever reach here (FR-022, FR-023, SC-005).
 */
@Injectable()
export class ConversionHistoryService {
  private readonly logger = new Logger(ConversionHistoryService.name);

  constructor(
    @InjectRepository(ConversionRecord)
    private readonly records: Repository<ConversionRecord>,
  ) {}

  /**
   * Write the record, and return its id so a retained file can be attached to
   * it afterwards.
   *
   * Never throws: this is called from a `finally` block, and a history failure
   * must not replace the answer the caller was about to receive — nor mask the
   * conversion error that got us here. `null` means the row was not written.
   */
  async record(attempt: ConversionAttempt): Promise<string | null> {
    try {
      const inserted = await this.records.insert(this.toRow(attempt));

      return (inserted.identifiers[0]?.id as string | undefined) ?? null;
    } catch (error) {
      this.logger.error('Failed to write a conversion record', error as Error);
      return null;
    }
  }

  private toRow(attempt: ConversionAttempt): Partial<ConversionRecord> {
    const failed = attempt.failure !== undefined;
    const category = failed ? this.categoryOf(attempt.failure) : null;

    return {
      userId: attempt.userId,
      transformationType: attempt.transformationType,
      // A name, truncated to the column; never content.
      originalFileName: attempt.originalFileName.slice(0, FILE_NAME_MAX_LENGTH),
      sourceFormat: attempt.sourceFormat,
      targetFormat: attempt.targetFormat,
      // `bigint` round-trips through TypeORM as a string.
      inputSizeBytes: String(attempt.inputSizeBytes),
      // The CHECK constraints spell these out in the schema as well: a success
      // carries a size and no category, a failure the reverse.
      outputSizeBytes: failed ? null : attempt.outputSizeBytes,
      outcome: failed ? ConversionOutcome.FAILURE : ConversionOutcome.SUCCESS,
      errorCategory: category,
      failureReason: failed ? this.reasonOf(attempt.failure) : null,
      retentionRequested: attempt.retentionRequested,
      retentionOutcome: attempt.retentionOutcome,
      storedFileId: attempt.storedFileId,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
    };
  }

  private categoryOf(failure: unknown): ConversionErrorCategory {
    return failure instanceof ConversionException
      ? failure.category
      : // Anything that is not one of ours is, by definition, unexpected.
        ConversionErrorCategory.INTERNAL_ERROR;
  }

  /**
   * The reason, as a code.
   *
   * An unexpected error contributes only the fact that it was unexpected — its
   * message could contain anything, including the input.
   */
  private reasonOf(failure: unknown): string {
    return failure instanceof ConversionException
      ? failure.toFailureReason()
      : 'internal_error';
  }
}
