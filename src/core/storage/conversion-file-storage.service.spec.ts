import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { buffer, text } from 'stream/consumers';

import { Logger } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import {
  ConversionStorageFileMissingError,
  ConversionStorageReadError,
  ConversionFileStorageService,
  ConversionStorageError,
} from './conversion-file-storage.service';

function spyOnLogger(
  target: ConversionFileStorageService,
): jest.SpyInstance<void, [unknown]> {
  const logger = (target as unknown as { logger: Logger }).logger;

  return jest
    .spyOn(logger, 'error')
    .mockImplementation(() => undefined) as unknown as jest.SpyInstance<
    void,
    [unknown]
  >;
}

function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('ConversionFileStorageService', () => {
  let root: string;
  let assets: string;
  let service: ConversionFileStorageService;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'conversion-storage-'));
    root = join(base, 'conversions');
    assets = join(base, 'assets');
    service = new ConversionFileStorageService(
      configWith({ CONVERSION_STORAGE_DIR: root, ASSETS_DIR: assets }),
    );
  });

  afterEach(async () => {
    await rm(resolve(root, '..'), { recursive: true, force: true });
  });

  describe('save', () => {
    it('creates the directory tree it needs', async () => {
      await service.save('user-1', 'file-1', 'json', Buffer.from('{}'));

      await expect(stat(join(root, 'user-1'))).resolves.toBeDefined();
    });

    it('writes to <userId>/<id>.<ext> and returns that relative path', async () => {
      const path = await service.save(
        'user-1',
        'file-1',
        'json',
        Buffer.from('{"a":1}'),
      );

      expect(path).toBe(join('user-1', 'file-1.json'));
      await expect(readFile(join(root, path), 'utf8')).resolves.toBe('{"a":1}');
    });

    it('keeps each owner in their own subtree', async () => {
      const first = await service.save('user-1', 'a', 'csv', Buffer.from('x'));
      const second = await service.save('user-2', 'b', 'csv', Buffer.from('y'));

      expect(first.startsWith('user-1')).toBe(true);
      expect(second.startsWith('user-2')).toBe(true);
    });

    it('returns a path relative to the root, not an absolute one', async () => {
      // Moving the root must be a configuration change, not a data migration.
      const path = await service.save(
        'user-1',
        'a',
        'yaml',
        Buffer.from('a: 1'),
      );

      expect(path).not.toContain(root);
    });

    it('writes the bytes unchanged', async () => {
      const bytes = Buffer.from('café 🇵🇱', 'utf8');

      const path = await service.save('user-1', 'a', 'csv', bytes);

      await expect(readFile(join(root, path))).resolves.toEqual(bytes);
    });

    it('surfaces a write failure as its own error type', async () => {
      // The caller has to tell "the conversion failed" apart from "only
      // keeping a copy failed" (FR-028).
      await service.save('seed', 'x', 'txt', Buffer.from('x'));

      // A root that is really a file: mkdir under it cannot succeed.
      const blocked = new ConversionFileStorageService(
        configWith({
          CONVERSION_STORAGE_DIR: join(root, 'seed', 'x.txt'),
          ASSETS_DIR: assets,
        }),
      );

      await expect(
        blocked.save('user-1', 'a', 'json', Buffer.from('{}')),
      ).rejects.toBeInstanceOf(ConversionStorageError);
    });
  });

  describe('delete', () => {
    it('removes a stored file', async () => {
      const path = await service.save('user-1', 'a', 'json', Buffer.from('{}'));

      await service.delete(path);

      await expect(stat(join(root, path))).rejects.toBeDefined();
    });

    it('stays quiet when the file is already gone', async () => {
      await expect(
        service.delete(join('user-1', 'missing.json')),
      ).resolves.toBeUndefined();
    });
  });

  describe('openForRead', () => {
    it('returns an exact stat and a descriptor-backed stream', async () => {
      const bytes = Buffer.from('descriptor-backed');
      const path = await service.save('user-1', 'a', 'json', bytes);

      const opened = await service.openForRead(path);

      expect(opened.size).toBe(bytes.length);
      await expect(buffer(opened.stream)).resolves.toEqual(bytes);
    });

    it('opens an independent descriptor for every repeated read', async () => {
      const path = await service.save(
        'user-1',
        'a',
        'json',
        Buffer.from('same bytes'),
      );

      const first = await service.openForRead(path);
      const second = await service.openForRead(path);

      await expect(
        Promise.all([text(first.stream), text(second.stream)]),
      ).resolves.toEqual(['same bytes', 'same bytes']);
    });

    it('keeps reading the opened descriptor after the path is removed', async () => {
      const path = await service.save(
        'user-1',
        'a',
        'json',
        Buffer.from('already open'),
      );
      const opened = await service.openForRead(path);
      await service.remove(path);

      await expect(text(opened.stream)).resolves.toBe('already open');
    });

    it.each(['../outside', '/tmp/outside', '', '.'])(
      'rejects a path that is not a contained file: %s',
      async (path) => {
        await expect(service.openForRead(path)).rejects.toBeInstanceOf(
          ConversionStorageReadError,
        );
      },
    );

    it('classifies a missing contained path without leaking it', async () => {
      await expect(
        service.openForRead(join('user-1', 'missing.json')),
      ).rejects.toEqual(
        expect.objectContaining({
          name: ConversionStorageFileMissingError.name,
          message: 'Stored conversion file is missing',
        }),
      );
    });

    it('classifies a non-file target as an unexpected read failure', async () => {
      await service.save('user-1', 'a', 'json', Buffer.from('{}'));

      await expect(service.openForRead('user-1')).rejects.toBeInstanceOf(
        ConversionStorageReadError,
      );
    });

    it('rejects an ancestor symlink that escapes the storage root', async () => {
      const outside = join(resolve(root, '..'), 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.json'), 'secret');
      await mkdir(root, { recursive: true });
      await symlink(outside, join(root, 'linked-owner'));

      await expect(
        service.openForRead('linked-owner/secret.json'),
      ).rejects.toBeInstanceOf(ConversionStorageReadError);
    });
  });

  describe('strict removal', () => {
    it('is idempotent for an already missing path', async () => {
      await expect(service.remove('user-1/missing.json')).resolves.toBe(
        'missing',
      );
    });

    it('rejects traversal rather than deleting outside the root', async () => {
      await expect(service.remove('../outside')).rejects.toBeInstanceOf(
        ConversionStorageReadError,
      );
    });

    it('surfaces unexpected unlink failures', async () => {
      await service.save('user-1', 'a', 'json', Buffer.from('{}'));

      await expect(service.remove('user-1')).rejects.toBeInstanceOf(
        ConversionStorageError,
      );
    });
  });

  describe('the root is never inside ASSETS_DIR (FR-027)', () => {
    // ASSETS_DIR is served unauthenticated at /assets/. A retained conversion
    // placed there would be readable by anyone who could guess the path, so
    // this is checked rather than assumed.
    it('accepts a root outside the assets tree', () => {
      expect(service.isInsideAssetsDir()).toBe(false);
    });

    it.each([
      ['the assets directory itself', (a: string) => a],
      ['a subdirectory of it', (a: string) => join(a, 'conversions')],
      ['a deeper subdirectory', (a: string) => join(a, 'a', 'b', 'c')],
    ])('rejects %s', (_label, build) => {
      const inside = new ConversionFileStorageService(
        configWith({
          CONVERSION_STORAGE_DIR: build(assets),
          ASSETS_DIR: assets,
        }),
      );

      expect(inside.isInsideAssetsDir()).toBe(true);
    });

    it('is not fooled by a sibling with a shared prefix', () => {
      const sibling = new ConversionFileStorageService(
        configWith({
          CONVERSION_STORAGE_DIR: `${assets}-conversions`,
          ASSETS_DIR: assets,
        }),
      );

      expect(sibling.isInsideAssetsDir()).toBe(false);
    });

    it('is not fooled by a relative path that escapes', () => {
      const outside = new ConversionFileStorageService(
        configWith({
          CONVERSION_STORAGE_DIR: join(assets, '..', 'conversions'),
          ASSETS_DIR: assets,
        }),
      );

      expect(outside.isInsideAssetsDir()).toBe(false);
    });

    it('complains loudly at startup when misconfigured', () => {
      const inside = new ConversionFileStorageService(
        configWith({
          CONVERSION_STORAGE_DIR: join(assets, 'conversions'),
          ASSETS_DIR: assets,
        }),
      );
      const error = spyOnLogger(inside);

      inside.onModuleInit();

      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('ASSETS_DIR');
    });

    it('says nothing at startup when configured correctly', () => {
      const error = spyOnLogger(service);

      service.onModuleInit();

      expect(error).not.toHaveBeenCalled();
    });
  });
});
