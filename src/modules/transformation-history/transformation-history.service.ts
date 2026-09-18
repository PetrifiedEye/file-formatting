import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  ConversionOutcome,
  RecordedFormat,
  TransformationType,
} from '@/modules/conversion/conversion.enums';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';

import { TransformationHistoryItemDto } from './dto/transformation-history-item.dto';
import { TransformationHistoryPageDto } from './dto/transformation-history-page.dto';
import { TransformationHistoryQueryDto } from './dto/transformation-history-query.dto';
import { TransformationHistoryStatus } from './transformation-history.enums';

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 20;
const INVALID_CURSOR_MESSAGE = 'Invalid cursor';

/** The query as the service actually ran it — what the cursor is bound to. */
interface EffectiveOptions {
  subjectUserId: string;
  type?: TransformationType;
  sourceFormat?: RecordedFormat;
  targetFormat?: RecordedFormat;
  status?: TransformationHistoryStatus;
  createdAtFrom?: string;
  createdAtTo?: string;
  limit: number;
}

interface CursorPayload {
  v: number;
  fp: string;
  id: string;
  createdAt: string;
}

/**
 * The columns this feature reads, and no others.
 *
 * Spelled out rather than selecting the entity: `conversion_records` also holds
 * the original file name, the failure reason, the retention fields and the
 * stored-file id, none of which may leave the server through this route
 * (FR-014). A `SELECT *` would make that a property of the mapping function
 * alone; this makes it a property of the query.
 */
const SELECTED_COLUMNS = [
  'record.id',
  'record.transformationType',
  'record.sourceFormat',
  'record.targetFormat',
  'record.outcome',
  'record.errorCategory',
  'record.inputSizeBytes',
  'record.durationMs',
  'record.createdAt',
] as const;

function base64UrlEncode(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

/**
 * Reads the transformation history features 010 and 011 write.
 *
 * The self route and the admin route are the same query with a different
 * subject, so there is one method: whose history is read is a parameter, and
 * the controller — not this service — decides who is allowed to ask.
 */
@Injectable()
export class TransformationHistoryService {
  private readonly hmacSecret: string;

  constructor(
    @InjectRepository(ConversionRecord)
    private readonly records: Repository<ConversionRecord>,
    private readonly configService: ConfigService,
  ) {
    this.hmacSecret = this.configService.get('JWT_ACCESS_SECRET');
  }

  async getHistory(
    subjectUserId: string,
    query: TransformationHistoryQueryDto,
  ): Promise<TransformationHistoryPageDto> {
    const options: EffectiveOptions = {
      subjectUserId,
      type: query.type,
      sourceFormat: query.sourceFormat,
      targetFormat: query.targetFormat,
      status: query.status,
      createdAtFrom: query.createdAtFrom,
      createdAtTo: query.createdAtTo,
      limit: query.limit ?? DEFAULT_LIMIT,
    };

    this.assertRangeOrdered(options);

    const fingerprint = this.computeFingerprint(options);

    const cursorPayload = query.cursor
      ? this.decodeCursor(query.cursor, fingerprint)
      : null;

    const qb = this.records
      .createQueryBuilder('record')
      .select([...SELECTED_COLUMNS])
      .where('record.userId = :subjectUserId', { subjectUserId });

    this.applyFilters(qb, options);
    this.applyKeyset(qb, cursorPayload);

    qb.orderBy('record.createdAt', 'DESC')
      .addOrderBy('record.id', 'DESC')
      .take(options.limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;

    const items = pageRows.map((row) => this.toItem(row));

    const nextCursor =
      hasMore && pageRows.length > 0
        ? this.encodeCursor(pageRows[pageRows.length - 1], fingerprint)
        : null;

    return { items, nextCursor };
  }

  /**
   * An inverted range matches nothing, so returning an empty page would be
   * defensible — and wrong. It is far more likely to be a mistake than an
   * intent, and FR-012 says to say so rather than answer it (reject, not
   * guess). Checked here rather than on the DTO because neither bound is
   * invalid on its own.
   */
  private assertRangeOrdered(options: EffectiveOptions): void {
    if (!options.createdAtFrom || !options.createdAtTo) {
      return;
    }

    if (Date.parse(options.createdAtTo) < Date.parse(options.createdAtFrom)) {
      throw new BadRequestException(
        'createdAtTo must not be earlier than createdAtFrom',
      );
    }
  }

  /** Each supplied filter narrows the result; AND throughout (FR-010). */
  private applyFilters(
    qb: SelectQueryBuilder<ConversionRecord>,
    options: EffectiveOptions,
  ): void {
    if (options.type) {
      qb.andWhere('record.transformationType = :type', { type: options.type });
    }

    if (options.sourceFormat) {
      qb.andWhere('record.sourceFormat = :sourceFormat', {
        sourceFormat: options.sourceFormat,
      });
    }

    if (options.targetFormat) {
      qb.andWhere('record.targetFormat = :targetFormat', {
        targetFormat: options.targetFormat,
      });
    }

    if (options.status) {
      // The contract's word is `error`; the column's is `failure`. Translated
      // here, in the one place both vocabularies are in scope.
      qb.andWhere('record.outcome = :outcome', {
        outcome:
          options.status === TransformationHistoryStatus.SUCCESS
            ? ConversionOutcome.SUCCESS
            : ConversionOutcome.FAILURE,
      });
    }

    // Both bounds inclusive, as the contract states.
    if (options.createdAtFrom) {
      qb.andWhere('record.createdAt >= :createdAtFrom', {
        createdAtFrom: options.createdAtFrom,
      });
    }

    if (options.createdAtTo) {
      qb.andWhere('record.createdAt <= :createdAtTo', {
        createdAtTo: options.createdAtTo,
      });
    }
  }

  /**
   * Strict `(created_at, id) < (cursor.createdAt, cursor.id)` in descending
   * order — the tuple, not `created_at` alone, so rows sharing a timestamp are
   * neither skipped nor served twice.
   */
  private applyKeyset(
    qb: SelectQueryBuilder<ConversionRecord>,
    cursor: CursorPayload | null,
  ): void {
    if (!cursor) {
      return;
    }

    qb.andWhere(
      '(record.createdAt < :cCreatedAt OR (record.createdAt = :cCreatedAt AND record.id < :cId))',
      { cCreatedAt: cursor.createdAt, cId: cursor.id },
    );
  }

  private toItem(row: ConversionRecord): TransformationHistoryItemDto {
    const status =
      row.outcome === ConversionOutcome.SUCCESS
        ? TransformationHistoryStatus.SUCCESS
        : TransformationHistoryStatus.ERROR;

    const item: TransformationHistoryItemDto = {
      id: row.id,
      type: row.transformationType,
      sourceFormat: row.sourceFormat,
      targetFormat: row.targetFormat,
      status,
      // `bigint` round-trips through TypeORM as a string. Safe to narrow: the
      // value is bounded by the conversion features' own per-format byte
      // ceilings, which are megabytes.
      fileSize: Number(row.inputSizeBytes),
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    };

    // Only on an error, and then always — the table's CHECK constraints make
    // "a failure has a category, a success has none" a schema invariant.
    if (status === TransformationHistoryStatus.ERROR && row.errorCategory) {
      item.errorCode = row.errorCategory;
    }

    return item;
  }

  /**
   * Binds a cursor to the exact query that produced it.
   *
   * `subjectUserId` is in here as well as in the payload precisely so a cursor
   * minted while reading one account's history cannot be presented while
   * reading another's — the admin route makes that a reachable request, not a
   * hypothetical one.
   */
  private computeFingerprint(options: EffectiveOptions): string {
    const payload = JSON.stringify({
      subjectUserId: options.subjectUserId,
      type: options.type ?? null,
      sourceFormat: options.sourceFormat ?? null,
      targetFormat: options.targetFormat ?? null,
      status: options.status ?? null,
      createdAtFrom: options.createdAtFrom ?? null,
      createdAtTo: options.createdAtTo ?? null,
      limit: options.limit,
    });

    return createHash('sha256').update(payload).digest('hex');
  }

  private encodeCursor(lastRow: ConversionRecord, fingerprint: string): string {
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      fp: fingerprint,
      id: lastRow.id,
      createdAt: lastRow.createdAt.toISOString(),
    };

    const json = JSON.stringify(payload);
    const jsonPart = base64UrlEncode(Buffer.from(json, 'utf8'));
    const signature = createHmac('sha256', this.hmacSecret)
      .update(json)
      .digest();

    return `${jsonPart}.${base64UrlEncode(signature)}`;
  }

  private decodeCursor(token: string, fingerprint: string): CursorPayload {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) {
        throw new Error('malformed');
      }

      const [jsonPart, signaturePart] = parts;
      const json = base64UrlDecode(jsonPart).toString('utf8');

      const expectedSignature = createHmac('sha256', this.hmacSecret)
        .update(json)
        .digest();
      const actualSignature = base64UrlDecode(signaturePart);

      if (
        expectedSignature.length !== actualSignature.length ||
        !timingSafeEqual(expectedSignature, actualSignature)
      ) {
        throw new Error('bad signature');
      }

      const payload = JSON.parse(json) as CursorPayload;

      if (payload.v !== CURSOR_VERSION) {
        throw new Error('bad version');
      }

      // Covers both a changed filter set and a cursor carried across from
      // another user's history: both are in the fingerprint.
      if (payload.fp !== fingerprint) {
        throw new Error('fingerprint mismatch');
      }

      return payload;
    } catch {
      // Uniform message: distinguishing "forged" from "stale" would tell a
      // caller which of the two they achieved.
      throw new BadRequestException(INVALID_CURSOR_MESSAGE);
    }
  }
}
