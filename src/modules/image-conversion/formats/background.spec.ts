import sharp from 'sharp';

import {
  opaqueBackground,
  overBackground,
  parseBackground,
  TRANSPARENT,
} from './background';
import { createRasterImage } from './raster-image';

describe('background', () => {
  describe('parseBackground', () => {
    it.each([
      ['transparent', TRANSPARENT],
      ['#ff8000', { r: 255, g: 128, b: 0, alpha: 1 }],
      ['#FF8000', { r: 255, g: 128, b: 0, alpha: 1 }],
      ['#00000080', { r: 0, g: 0, b: 0, alpha: 128 / 255 }],
      ['#ffffff00', { r: 255, g: 255, b: 255, alpha: 0 }],
    ])('parses %s', (value, expected) => {
      expect(parseBackground(value)).toEqual(expected);
    });
  });

  describe('opaqueBackground (what a JPEG can use)', () => {
    it.each([
      ['transparent is white', TRANSPARENT, { r: 255, g: 255, b: 255 }],
      [
        'an opaque colour is itself',
        { r: 10, g: 20, b: 30, alpha: 1 },
        { r: 10, g: 20, b: 30 },
      ],
      [
        'a translucent colour is composited onto white',
        { r: 0, g: 0, b: 255, alpha: 0.5 },
        { r: 128, g: 128, b: 255 },
      ],
    ])('%s', (_label, background, expected) => {
      expect(opaqueBackground(background)).toEqual(expected);
    });
  });

  describe('overBackground (a target that keeps alpha)', () => {
    /** One fully transparent pixel. */
    const clear = () =>
      createRasterImage(
        {
          data: Buffer.from([0, 0, 0, 0]),
          width: 1,
          height: 1,
          channels: 4,
          hasAlpha: true,
        },
        { maxPixels: 1 },
      );

    const pixel = async (pipeline: sharp.Sharp) => [
      ...(await pipeline.raw().toBuffer()),
    ];

    it('leaves a transparent background alone', async () => {
      expect(await pixel(await overBackground(clear(), TRANSPARENT))).toEqual([
        0, 0, 0, 0,
      ]);
    });

    it('flattens onto an opaque one', async () => {
      expect(
        await pixel(
          await overBackground(clear(), { r: 255, g: 0, b: 0, alpha: 1 }),
        ),
      ).toEqual([255, 0, 0]);
    });

    it('lays a translucent one underneath, keeping alpha', async () => {
      expect(
        await pixel(
          await overBackground(clear(), { r: 0, g: 255, b: 0, alpha: 0.5 }),
        ),
      ).toEqual([0, 255, 0, 128]);
    });

    it('does nothing to an image without alpha', async () => {
      const opaque = createRasterImage(
        {
          data: Buffer.from([1, 2, 3]),
          width: 1,
          height: 1,
          channels: 3,
          hasAlpha: false,
        },
        { maxPixels: 1 },
      );

      expect(
        await pixel(
          await overBackground(opaque, { r: 255, g: 0, b: 0, alpha: 1 }),
        ),
      ).toEqual([1, 2, 3]);
    });
  });
});
