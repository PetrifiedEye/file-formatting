import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';

import { SettingsAuditEvent } from './entities/settings-audit-event.entity';
import { SettingsAuditService } from './settings-audit.service';
import { SystemSettings } from './entities/system-settings.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { AdminGuard } from './guards/admin.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemSettings, SettingsAuditEvent]),
    forwardRef(() => AuthModule),
    forwardRef(() => RbacModule),
  ],
  controllers: [SettingsController],
  providers: [SettingsService, SettingsAuditService, AdminGuard],
  exports: [SettingsService, TypeOrmModule],
})
export class SettingsModule {}
