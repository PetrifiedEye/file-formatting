import sharp from 'sharp';

import { ConversionException } from '@/modules/conversion/conversion.exception';

import {
  expectRefusal,
  imageFixture,
  pixelsOf,
  testContext,
} from './image-test-support';
import { createRasterImage } from './raster-image';
import {
  decodeRaster,
  encodeRaster,
  enforcePixelBudget,
  readHeader,
} from './sharp-raster';

describe('sharp-raster', () => {
  describe('readHeader', () => {
    it('reads the declared size and alpha without decoding', async () => {
      await expect(
        readHeader(imageFixture('transparent.png')),
      ).resolves.toEqual({
        width: 64,
        height: 48,
        hasAlpha: true,
        transposed: false,
      });
    });

    it('flags an EXIF orientation that swaps width and height', async () => {
      const header = await readHeader(imageFixture('exif-rotated.jpg'));

      expect(header.transposed).toBe(true);
    });

    it('refuses bytes that are not an image, without quoting them', async () => {
      await expectRefusal(
        () => readHeader(imageFixture('not-an-image.png')),
        'image_invalid',
      );
    });
  });

  describe('enforcePixelBudget', () => {
    it('allows exactly the budget', () => {
      expect(() => enforcePixelBudget(100, 100, 10_000)).not.toThrow();
    });

    it('refuses one pixel over, naming the numbers', () => {
      try {
        enforcePixelBudget(101, 100, 10_000);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionException);
        expect(error).toMatchObject({
          code: 'image_pixel_budget_exceeded',
          params: { pixels: 10_100, limit: 10_000 },
        });
      }
    });
  });

  describe('decodeRaster', () => {
    it('describes the upright image without decoding it', async () => {
      const image = await decodeRaster(
        imageFixture('exif-rotated.jpg'),
        testContext(),
        false,
      );

      // Stored 48x64, displayed 64x48: the hub is what a viewer shows.
      expect(image).toMatchObject({
        width: 64,
        height: 48,
        channels: 3,
        hasAlpha: false,
        decodesOnRead: true,
      });

      const { info } = await image
        .toSharp()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height, info.channels]).toEqual([64, 48, 3]);
    });

    it('keeps alpha only when asked to', async () => {
      const png = imageFixture('transparent.png');

      const kept = await decodeRaster(png, testContext(), true);
      const dropped = await decodeRaster(png, testContext(), false);

      expect(kept.channels).toBe(4);
      expect(await pixelsOf(kept)).toHaveLength(64 * 48 * 4);
      expect(dropped.channels).toBe(3);
      expect(await pixelsOf(dropped)).toHaveLength(64 * 48 * 3);
    });

    it('normalises a 16-bit source to 8 bits per channel', async () => {
      const image = await decodeRaster(
        imageFixture('sixteen-bit.png'),
        testContext(),
        true,
      );

      const pixels = await pixelsOf(image);
      expect(pixels).toHaveLength(image.width * image.height * image.channels);
    });

    it('refuses an over-budget declaration before anything is allocated', async () => {
      await expectRefusal(
        () =>
          decodeRaster(
            imageFixture('solid.png'),
            testContext({ maxPixels: 100 }),
            true,
          ),
        'image_pixel_budget_exceeded',
      );
    });
  });

  describe('encodeRaster', () => {
    const failing = () => Promise.reject(new Error('vips: something broke'));

    it('reports a failure producing decoded pixels as the input s fault', async () => {
      const image = await decodeRaster(
        imageFixture('solid.png'),
        testContext(),
        true,
      );

      await expectRefusal(() => encodeRaster(image, failing), 'image_invalid');
    });

    it('reports a failure over pixels already in memory as ours', async () => {
      const image = createRasterImage(
        {
          data: Buffer.alloc(4),
          width: 1,
          height: 1,
          channels: 4,
          hasAlpha: true,
        },
        { maxPixels: 10 },
      );

      await expectRefusal(() => encodeRaster(image, failing), 'internal_error');
    });

    it('passes a successful encode through', async () => {
      const image = await decodeRaster(
        imageFixture('solid.png'),
        testContext(),
        true,
      );

      const encoded = await encodeRaster(image, () =>
        image.toSharp().png().toBuffer(),
      );

      expect((await sharp(encoded).metadata()).format).toBe('png');
    });
  });
});
