import { Module } from '@nestjs/common';

import { ConversionFileStorageService } from './conversion-file-storage.service';
import { LocalFileStorageService } from './local-file-storage.service';

@Module({
  // Two roots, deliberately: `LocalFileStorageService` writes under the
  // unauthenticated `ASSETS_DIR`, and retained conversions must not (FR-027).
  providers: [LocalFileStorageService, ConversionFileStorageService],
  exports: [LocalFileStorageService, ConversionFileStorageService],
})
export class StorageModule {}
