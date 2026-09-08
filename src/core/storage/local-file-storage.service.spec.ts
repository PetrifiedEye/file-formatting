import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigService } from '@/core/config/config.service';

import { LocalFileStorageService } from './local-file-storage.service';

describe('LocalFileStorageService', () => {
  let service: LocalFileStorageService;
  let assetsDir: string;

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(tmpdir(), 'assets-'));
    const configService = {
      get: jest.fn().mockReturnValue(assetsDir),
    } as unknown as ConfigService;
    service = new LocalFileStorageService(configService);
  });

  afterEach(async () => {
    await rm(assetsDir, { recursive: true, force: true });
  });

  it('writes the buffer to disk and returns a relative path', async () => {
    const buffer = Buffer.from('fake-image-bytes');

    const relativePath = await service.save(buffer, 'jpg');

    expect(relativePath).toMatch(/^photos[/\\][0-9a-f-]+\.jpg$/);
    const written = await readFile(join(assetsDir, relativePath));
    expect(written).toEqual(buffer);
  });

  it('deletes a file best-effort and does not throw when the file is missing', async () => {
    await expect(
      service.delete('photos/does-not-exist.jpg'),
    ).resolves.toBeUndefined();
  });
});
