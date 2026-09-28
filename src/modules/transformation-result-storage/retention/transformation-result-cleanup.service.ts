import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import { ConversionFileStorageService } from '@/core/storage/conversion-file-storage.service';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';

const CLEANUP_BATCH_SIZE = 100;

interface ExpiringRecord extends ConversionRecord {
  expiresAt: Date;
}

interface CleanupConfigReader {
  get(key: 'TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS'): string;
}

export interface CleanupCycleResult {
  deleted: number;
  failed: number;
}

@Injectable()
export class TransformationResultCleanupService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TransformationResultCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectRepository(ConversionRecord)
    private readonly records: Repository<ConversionRecord>,
    private readonly storage: ConversionFileStorageService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = Number(
      (this.configService as ConfigService & CleanupConfigReader).get(
        'TRANSFORMATION_RETENTION_CLEANUP_INTERVAL_MS',
      ),
    );

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScheduledCleanup();
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCleanupCycle(now = new Date()): Promise<CleanupCycleResult> {
    let deleted = 0;
    let failed = 0;
    let cursor: { expiresAt: Date; id: string } | null = null;

    for (;;) {
      const rows = await this.expiredBatch(now, cursor);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        try {
          if (row.storedFile?.storagePath) {
            await this.storage.remove(row.storedFile.storagePath);
          }
          await this.records.delete({ id: row.id });
          deleted += 1;
        } catch (error) {
          failed += 1;
          this.logger.error(
            `Failed to clean expired transformation record ${row.id}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }

      const last = rows[rows.length - 1];
      cursor = { expiresAt: last.expiresAt, id: last.id };
      if (rows.length < CLEANUP_BATCH_SIZE) {
        break;
      }
    }

    this.logger.log(
      `Transformation result cleanup completed deleted=${deleted} failed=${failed}`,
    );
    return { deleted, failed };
  }

  private async runScheduledCleanup(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      await this.runCleanupCycle();
    } catch (error) {
      this.logger.error(
        'Transformation result cleanup cycle failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }

  private async expiredBatch(
    now: Date,
    cursor: { expiresAt: Date; id: string } | null,
  ): Promise<ExpiringRecord[]> {
    const query = this.records
      .createQueryBuilder('record')
      .leftJoinAndSelect('record.storedFile', 'storedFile')
      .select([
        'record.id',
        'record.expiresAt',
        'storedFile.id',
        'storedFile.storagePath',
      ])
      .where('record.expiresAt <= :now', { now })
      .orderBy('record.expiresAt', 'ASC')
      .addOrderBy('record.id', 'ASC')
      .take(CLEANUP_BATCH_SIZE);

    this.applyCursor(query, cursor);
    return (await query.getMany()) as ExpiringRecord[];
  }

  private applyCursor(
    query: SelectQueryBuilder<ConversionRecord>,
    cursor: { expiresAt: Date; id: string } | null,
  ): void {
    if (!cursor) {
      return;
    }

    query.andWhere(
      '(record.expiresAt > :cursorExpiry OR ' +
        '(record.expiresAt = :cursorExpiry AND record.id > :cursorId))',
      {
        cursorExpiry: cursor.expiresAt,
        cursorId: cursor.id,
      },
    );
  }
}
