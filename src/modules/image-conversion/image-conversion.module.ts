import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';
import { StorageModule } from '@/core/storage/storage.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionModule } from '@/modules/conversion/conversion.module';
import { ConversionRecord } from '@/modules/conversion/entities/conversion-record.entity';
import { ConversionStoredFile } from '@/modules/conversion/entities/conversion-stored-file.entity';
import { UserRole } from '@/modules/rbac/entities/user-role.entity';
import { User } from '@/modules/users/entities/user.entity';

import {
  IMAGE_CONVERSION_LIMITS,
  IMAGE_FORMAT_HANDLERS,
} from './formats/image-format-handler';
import type {
  ImageConversionLimits,
  ImageFormatHandler,
} from './formats/image-format-handler';
import { JpegHandler } from './formats/jpeg.handler';
import { PngHandler } from './formats/png.handler';
import { SvgHandler } from './formats/svg.handler';
import { ImageConversionController } from './image-conversion.controller';
import { ImageConversionService } from './image-conversion.service';
import { ImageFormatDetectorService } from './image-format-detector.service';
import { ImageFormatRegistryService } from './image-format-registry.service';

/**
 * Image conversion.
 *
 * A module of its own rather than part of `ConversionModule`: the text hub is
 * `read → DocumentNode → write` over UTF-8 with every pair supported, while
 * images are bytes with no document model and an allow-list of directions.
 * Merging them would reintroduce exactly the pairwise branching both features
 * are designed to avoid.
 *
 * The edge to `ConversionModule` is one-directional — image-conversion reads
 * its history, retention, error vocabulary, and upload reader; nothing in
 * feature 010 knows this module exists.
 */
@Module({
  imports: [
    ConfigModule,
    StorageModule,
    AuthModule,
    ConversionModule,
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
  controllers: [ImageConversionController],
  providers: [
    ImageConversionService,
    ImageFormatDetectorService,
    ImageFormatRegistryService,
    PngHandler,
    JpegHandler,
    SvgHandler,
    {
      // A fourth format is one more entry here and one new file. No existing
      // handler, the controller, the DTOs, the detector, and the discovery
      // endpoint all stay untouched (FR-033, SC-014).
      provide: IMAGE_FORMAT_HANDLERS,
      inject: [PngHandler, JpegHandler, SvgHandler],
      useFactory: (...handlers: ImageFormatHandler[]) => handlers,
    },
    {
      // Resolved once, here, and injected everywhere else. Handlers never read
      // configuration themselves: that keeps each unit-testable against
      // arbitrary limits and stops one inventing a ceiling of its own.
      provide: IMAGE_CONVERSION_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ImageConversionLimits => ({
        maxInputBytes: {
          [ImageFormat.PNG]: Number(config.get('IMAGE_MAX_BYTES_PNG')),
          [ImageFormat.JPEG]: Number(config.get('IMAGE_MAX_BYTES_JPEG')),
          [ImageFormat.SVG]: Number(config.get('IMAGE_MAX_BYTES_SVG')),
        },
        maxOutputWidth: Number(config.get('IMAGE_MAX_OUTPUT_WIDTH')),
        maxOutputHeight: Number(config.get('IMAGE_MAX_OUTPUT_HEIGHT')),
        maxPixels: Number(config.get('IMAGE_MAX_PIXELS')),
        maxOutputBytes: Number(config.get('IMAGE_MAX_OUTPUT_BYTES')),
        backgroundColor: String(config.get('IMAGE_BACKGROUND_COLOR')),
        jpegQuality: Number(config.get('IMAGE_JPEG_QUALITY')),
        timeoutMs: Number(config.get('IMAGE_CONVERSION_TIMEOUT_MS')),
        maxConcurrent: Number(config.get('IMAGE_MAX_CONCURRENT')),
        // Empty is meaningful, and is not the same as "some default
        // directory": it means no fonts at all and no system-font scan.
        svgFontDir: String(config.get('IMAGE_SVG_FONT_DIR') ?? '') || null,
      }),
    },
  ],
  exports: [ImageFormatRegistryService, IMAGE_CONVERSION_LIMITS],
})
export class ImageConversionModule {}
