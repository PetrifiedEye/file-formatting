import { Injectable, Logger } from '@nestjs/common';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';

import { ConfigService } from '@/core/config/config.service';

/** Distinguishable from a conversion failure, because it is not one. */
export class ConversionStorageError extends Error {
  constructor(cause?: unknown) {
    super('Failed to store the converted file');
    this.name = 'ConversionStorageError';
    this.cause = cause;
  }
}

/**
 * Writes retained conversion results under `CONVERSION_STORAGE_DIR`.
 *
 * **Deliberately not `ASSETS_DIR`.** `main.ts` registers `@fastify/static` with
 * `root: ASSETS_DIR, prefix: '/assets/'`, and that route has no authentication
 * — anything under it is readable by anyone who can guess or obtain the path.
 * FR-027 requires retained files to stay private to their owner, so they live
 * outside the statically served tree. Nothing in this feature serves them over
 * HTTP at all.
 *
 * `LocalFileStorageService` is left alone rather than extended: it hard-codes
 * the assets root and the `photos` subdirectory, which is exactly what must not
 * be reused here.
 */
@Injectable()
export class ConversionFileStorageService {
  private readonly logger = new Logger(ConversionFileStorageService.name);

  constructor(private readonly configService: ConfigService) {}

  /** The configured root, resolved to an absolute path. */
  root(): string {
    return resolve(this.configService.get('CONVERSION_STORAGE_DIR'));
  }

  /**
   * Store one result at `<userId>/<id>.<ext>`, relative to the root.
   *
   * Returns that relative path, which is what the database records — so moving
   * the root is a configuration change and not a data migration.
   */
  async save(
    userId: string,
    id: string,
    extension: string,
    buffer: Buffer,
  ): Promise<string> {
    const relativePath = join(userId, `${id}.${extension}`);

    try {
      await mkdir(join(this.root(), userId), { recursive: true });
      await writeFile(join(this.root(), relativePath), buffer);
    } catch (error) {
      // Surfaced as its own type: the caller must be able to tell "the
      // conversion failed" from "only keeping a copy failed" (FR-028).
      this.logger.error(
        `Failed to store a converted file for user ${userId}`,
        error as Error,
      );
      throw new ConversionStorageError(error);
    }

    return relativePath;
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await unlink(join(this.root(), relativePath));
    } catch (error) {
      this.logger.warn(
        `Failed to delete a stored conversion at ${relativePath}`,
        error as Error,
      );
    }
  }

  /**
   * Whether the configured root sits inside the unauthenticated assets tree.
   *
   * Checked at startup rather than trusted: the whole privacy guarantee of
   * FR-027 rests on these two directories being disjoint, and a single careless
   * `.env` edit would otherwise publish every retained file silently.
   */
  isInsideAssetsDir(): boolean {
    const assets = resolve(this.configService.get('ASSETS_DIR'));
    const storage = this.root();
    const offset = relative(assets, storage);

    return (
      storage === assets ||
      (offset !== '' && !offset.startsWith('..') && !offset.startsWith(sep))
    );
  }

  onModuleInit(): void {
    if (this.isInsideAssetsDir()) {
      this.logger.error(
        'CONVERSION_STORAGE_DIR is inside ASSETS_DIR, which @fastify/static ' +
          'serves without authentication. Retained conversions would be ' +
          'readable by anyone who can guess their path (FR-027). Move it ' +
          'outside the assets tree.',
      );
    }
  }
}
