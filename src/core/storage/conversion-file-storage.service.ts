import { Injectable, Logger } from '@nestjs/common';
import { constants, type ReadStream } from 'fs';
import {
  type FileHandle,
  mkdir,
  open,
  realpath,
  unlink,
  writeFile,
} from 'fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path';

import { ConfigService } from '@/core/config/config.service';

/** Distinguishable from a conversion failure, because it is not one. */
export class ConversionStorageError extends Error {
  constructor(cause?: unknown) {
    super('Failed to store the converted file');
    this.name = 'ConversionStorageError';
    this.cause = cause;
  }
}

export class ConversionStorageFileMissingError extends Error {
  constructor() {
    super('Stored conversion file is missing');
    this.name = 'ConversionStorageFileMissingError';
  }
}

export class ConversionStorageReadError extends Error {
  constructor(cause?: unknown) {
    super('Failed to open the stored conversion file');
    this.name = 'ConversionStorageReadError';
    this.cause = cause;
  }
}

export interface OpenedConversionFile {
  stream: ReadStream;
  size: number;
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
      await this.remove(relativePath);
    } catch (error) {
      this.logger.warn('Failed to delete a stored conversion', error as Error);
    }
  }

  /**
   * Remove one stored file. Missing files are already-clean state; every other
   * failure is strict so lifecycle cleanup can retain the database row for a
   * later retry.
   */
  async remove(relativePath: string): Promise<'removed' | 'missing'> {
    try {
      const path = await this.containedPath(relativePath);
      await unlink(path);
      return 'removed';
    } catch (error) {
      if (
        error instanceof ConversionStorageFileMissingError ||
        isErrorCode(error, 'ENOENT')
      ) {
        return 'missing';
      }
      if (error instanceof ConversionStorageReadError) {
        throw error;
      }
      throw new ConversionStorageError(error);
    }
  }

  /**
   * Open and stat through one descriptor before any HTTP headers are written.
   *
   * `O_NOFOLLOW` rejects a final-component symlink. The lexical containment
   * check also rejects absolute paths and traversal before touching storage.
   * The returned stream owns the descriptor and closes it on end/error.
   */
  async openForRead(relativePath: string): Promise<OpenedConversionFile> {
    let handle: FileHandle | undefined;

    try {
      handle = await open(
        await this.containedPath(relativePath),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const fileStat = await handle.stat();

      if (!fileStat.isFile()) {
        throw new ConversionStorageReadError();
      }

      return {
        stream: handle.createReadStream({ autoClose: true }),
        size: fileStat.size,
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      if (
        error instanceof ConversionStorageReadError ||
        error instanceof ConversionStorageFileMissingError
      ) {
        throw error;
      }
      if (isErrorCode(error, 'ENOENT')) {
        throw new ConversionStorageFileMissingError();
      }
      throw new ConversionStorageReadError(error);
    }
  }

  private async containedPath(relativePath: string): Promise<string> {
    const root = this.root();
    const path = resolve(root, relativePath);
    const offset = relative(root, path);
    const contained =
      !isAbsolute(relativePath) &&
      offset !== '' &&
      !offset.startsWith('..') &&
      !isAbsolute(offset) &&
      !offset.startsWith(sep);

    if (!contained) {
      throw new ConversionStorageReadError();
    }

    try {
      const [canonicalRoot, canonicalParent] = await Promise.all([
        realpath(root),
        realpath(dirname(path)),
      ]);
      const parentOffset = relative(canonicalRoot, canonicalParent);
      if (
        canonicalParent !== canonicalRoot &&
        (parentOffset.startsWith('..') || isAbsolute(parentOffset))
      ) {
        throw new ConversionStorageReadError();
      }

      return join(canonicalParent, basename(path));
    } catch (error) {
      if (error instanceof ConversionStorageReadError) {
        throw error;
      }
      if (isErrorCode(error, 'ENOENT')) {
        throw new ConversionStorageFileMissingError();
      }
      throw new ConversionStorageReadError(error);
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

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
