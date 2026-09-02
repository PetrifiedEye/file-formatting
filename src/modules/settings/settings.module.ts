import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemSettings } from './entities/system-settings.entity';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { AdminGuard } from './guards/admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSettings])],
  controllers: [SettingsController],
  providers: [SettingsService, AdminGuard],
  exports: [SettingsService, TypeOrmModule],
})
export class SettingsModule {}
