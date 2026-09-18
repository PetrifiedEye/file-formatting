import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '@/core/config/config.module';
import { StorageModule } from '@/core/storage/storage.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';
import { ConversionStoredFile } from '@/modules/conversion/entities/conversion-stored-file.entity';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { SettingsModule } from '@/modules/settings/settings.module';
import { User } from '@/modules/users/entities/user.entity';
import { UsersModule } from '@/modules/users/users.module';

import { AdminResultDownloadController } from './admin-result-download.controller';
import { TransformationResultAuditEvent } from './entities/transformation-result-audit-event.entity';
import { SelfResultDownloadController } from './self-result-download.controller';
import { TransformationResultAuditFilter } from './transformation-result-audit.filter';
import { TransformationResultAuditService } from './transformation-result-audit.service';
import { TransformationResultCleanupService } from './transformation-result-cleanup.service';
import { TransformationResultDownloadService } from './transformation-result-download.service';
import { TransformationRetentionPolicyService } from './transformation-retention-policy.service';

@Module({
  imports: [
    ConfigModule,
    StorageModule,
    AuthModule,
    RbacModule,
    UsersModule,
    SettingsModule,
    TypeOrmModule.forFeature([
      ConversionRecord,
      ConversionStoredFile,
      TransformationResultAuditEvent,
      User,
      UserRole,
    ]),
  ],
  controllers: [SelfResultDownloadController, AdminResultDownloadController],
  providers: [
    TransformationResultDownloadService,
    TransformationResultCleanupService,
    TransformationRetentionPolicyService,
    TransformationResultAuditService,
    TransformationResultAuditFilter,
  ],
  exports: [
    TransformationRetentionPolicyService,
    TransformationResultAuditService,
  ],
})
export class TransformationResultStorageModule {}
