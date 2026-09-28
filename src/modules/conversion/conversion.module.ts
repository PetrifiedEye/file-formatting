import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';
import { StorageModule } from '@/core/storage/storage.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { TransformationResultStorageModule } from '@/modules/transformation-result-storage/transformation-result-storage.module';
import { User } from '@/modules/users/entities/user.entity';

import { ConversionController } from './conversion.controller';
import { ConversionHistoryService } from '@/modules/conversion/history/conversion-history.service';
import { ConversionRetentionService } from '@/modules/conversion/history/conversion-retention.service';
import { ConversionFormat } from './conversion.enums';
import { ConversionService } from './conversion.service';
import { ConversionRecord } from './entities/conversion-record.entity';
import { ConversionStoredFile } from './entities/conversion-stored-file.entity';
import { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { CONVERSION_LIMITS, FORMAT_HANDLERS } from './formats/format-handler';
import type { ConversionLimits } from './formats/format-handler';
import { createFormatHandlers } from './formats/format-handlers';
import { DOCUMENT_CONVERSION_EXECUTOR } from './pipeline/document-conversion.executor';
import { WorkerPoolDocumentConversionExecutor } from './pipeline/worker-pool.executor';
import { InProcessDocumentConversionExecutor } from './pipeline/document-conversion.executor';

@Module({
  imports: [
    ConfigModule,
    StorageModule,
    AuthModule,
    TransformationResultStorageModule,
    TypeOrmModule.forFeature([
      ConversionRecord,
      ConversionStoredFile,
      // Read-only, and only so `JwtAuthGuard` can be constructed here: Nest
      // instantiates a guard in the module that applies it, so the guard's own
      // repositories must resolve in this context.
      User,
      UserRole,
    ]),
  ],
  controllers: [ConversionController],
  providers: [
    ConversionService,
    ConversionHistoryService,
    ConversionRetentionService,
    FormatDetectorService,
    FormatRegistryService,
    {
      // The same list the worker threads build their registry from, so the
      // formats advertised and the formats converted cannot drift apart.
      provide: FORMAT_HANDLERS,
      useFactory: createFormatHandlers,
    },
    {
      // Parsing and serializing run in worker threads: a large document never
      // blocks the event loop, and the deadline can stop a parse mid-way.
      provide: DOCUMENT_CONVERSION_EXECUTOR,
      inject: [
        ConfigService,
        CONVERSION_LIMITS,
        FormatRegistryService,
        FormatDetectorService,
      ],
      useFactory: (
        config: ConfigService,
        limits: ConversionLimits,
        registry: FormatRegistryService,
        detector: FormatDetectorService,
      ) =>
        String(config.get('CONVERSION_USE_WORKER_THREADS')) === 'false'
          ? new InProcessDocumentConversionExecutor(registry, detector)
          : new WorkerPoolDocumentConversionExecutor(limits),
    },
    {
      // Resolved once, here, and injected everywhere else. Handlers never read
      // configuration themselves: that keeps each one unit-testable against
      // arbitrary limits and stops one from inventing a ceiling of its own.
      provide: CONVERSION_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ConversionLimits => ({
        maxInputBytes: {
          [ConversionFormat.CSV]: Number(
            config.get('CONVERSION_MAX_BYTES_CSV'),
          ),
          [ConversionFormat.JSON]: Number(
            config.get('CONVERSION_MAX_BYTES_JSON'),
          ),
          [ConversionFormat.XML]: Number(
            config.get('CONVERSION_MAX_BYTES_XML'),
          ),
          [ConversionFormat.YAML]: Number(
            config.get('CONVERSION_MAX_BYTES_YAML'),
          ),
        },
        maxOutputBytes: Number(config.get('CONVERSION_MAX_OUTPUT_BYTES')),
        maxDepth: Number(config.get('CONVERSION_MAX_DEPTH')),
        maxNodes: Number(config.get('CONVERSION_MAX_NODES')),
        maxCsvColumns: Number(config.get('CONVERSION_MAX_CSV_COLUMNS')),
        timeoutMs: Number(config.get('CONVERSION_TIMEOUT_MS')),
        maxConcurrent: Number(config.get('CONVERSION_MAX_CONCURRENT')),
        maxQueue: Number(config.get('CONVERSION_MAX_QUEUE')),
      }),
    },
  ],
  // History and retention are exported so the image module can write into the
  // *same* conversion history (feature 011, FR-024) rather than growing a
  // parallel one. The edge is one-directional: image-conversion → conversion.
  exports: [
    FormatRegistryService,
    CONVERSION_LIMITS,
    ConversionHistoryService,
    ConversionRetentionService,
  ],
})
export class ConversionModule {}
