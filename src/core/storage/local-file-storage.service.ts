import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

import { ConfigService } from '@/core/config/config.service';

@Injectable()
export class LocalFileStorageService {
  private readonly logger = new Logger(LocalFileStorageService.name);

  constructor(private readonly configService: ConfigService) {}

  async save(buffer: Buffer, ext: string): Promise<string> {
    const relativePath = join('photos', `${randomUUID()}.${ext}`);
    const absoluteDir = join(this.configService.get('ASSETS_DIR'), 'photos');
    await mkdir(absoluteDir, { recursive: true });
    await writeFile(
      join(this.configService.get('ASSETS_DIR'), relativePath),
      buffer,
    );

    return relativePath;
  }

  async delete(path: string): Promise<void> {
    try {
      await unlink(join(this.configService.get('ASSETS_DIR'), path));
    } catch (error) {
      this.logger.warn(`Failed to delete asset file ${path}`, error as Error);
    }
  }
}
