import { readFileSync } from 'fs';
import { join } from 'path';

import { ImageFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import type {
  ImageConversionContext,
  ImageConversionLimits,
} from './image-format-handler';

/** Shared by the handler specs. Not imported by anything under `src` at runtime. */
const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'support',
  'image-fixtures',
);

export function imageFixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

export const TEST_LIMITS: ImageConversionLimits = {
  maxInputBytes: {
    [ImageFormat.PNG]: 10485760,
    [ImageFormat.JPEG]: 10485760,
    [ImageFormat.SVG]: 2097152,
  },
  maxOutputWidth: 8192,
  maxOutputHeight: 8192,
  maxPixels: 16000000,
  maxOutputBytes: 20971520,
  backgroundColor: '#ffffff',
  jpegQuality: 85,
  timeoutMs: 30000,
  maxConcurrent: 2,
  svgFontDir: null,
};

export function testContext(
  overrides: Partial<ImageConversionLimits> = {},
  signal?: AbortSignal,
): ImageConversionContext {
  return { limits: { ...TEST_LIMITS, ...overrides }, signal };
}

/** Assert a call refuses with one of our codes, not a library message. */
export async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(ConversionException);
  await expect(run()).rejects.toMatchObject({ code });
}

/** The RGBA value at one pixel of a raw buffer. */
export function pixelAt(
  data: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
): number[] {
  const offset = (y * width + x) * channels;

  return [...data.subarray(offset, offset + channels)];
}
