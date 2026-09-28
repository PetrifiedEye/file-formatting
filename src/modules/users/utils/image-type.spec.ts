import { detectImageExtension } from './image-type';

describe('detectImageExtension', () => {
  it.each([
    ['a JPEG', [0xff, 0xd8, 0xff, 0xe0], 'jpg'],
    ['a PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], 'png'],
    [
      'a WebP',
      [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
      'webp',
    ],
  ])('recognises %s from its magic bytes', (_label, bytes, extension) => {
    expect(detectImageExtension(Buffer.from(bytes))).toBe(extension);
  });

  it.each([
    ['an empty buffer', []],
    ['text', [...Buffer.from('hello world!')]],
    ['a truncated JPEG signature', [0xff, 0xd8]],
    [
      'a RIFF that is not WebP',
      [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')],
    ],
    ['a GIF', [...Buffer.from('GIF89a')]],
  ])('returns null for %s', (_label, bytes) => {
    expect(detectImageExtension(Buffer.from(bytes))).toBeNull();
  });
});
