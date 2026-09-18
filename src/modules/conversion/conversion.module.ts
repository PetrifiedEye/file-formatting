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
import { ConversionHistoryService } from './conversion-history.service';
import { ConversionRetentionService } from './conversion-retention.service';
import { ConversionFormat } from './conversion.enums';
import { ConversionService } from './conversion.service';
import { ConversionRecord } from './entities/conversion-record.entity';
import { ConversionStoredFile } from './entities/conversion-stored-file.entity';
import { FormatDetectorService } from './format-detector.service';
import { FormatRegistryService } from './format-registry.service';
import { CsvHandler } from './formats/csv.handler';
import { CONVERSION_LIMITS, FORMAT_HANDLERS } from './formats/format-handler';
import type { ConversionLimits, FormatHandler } from './formats/format-handler';
import { JsonHandler } from './formats/json.handler';
import { XmlHandler } from './formats/xml.handler';
import { YamlHandler } from './formats/yaml.handler';

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
    CsvHandler,
    JsonHandler,
    XmlHandler,
    YamlHandler,
    {
      // The whole extensibility story in one place: a fifth format is one more
      // entry here and one new file. No existing handler, the controller, the
      // DTOs, and the discovery endpoint all stay untouched (FR-029).
      provide: FORMAT_HANDLERS,
      inject: [CsvHandler, JsonHandler, XmlHandler, YamlHandler],
      useFactory: (...handlers: FormatHandler[]) => handlers,
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
