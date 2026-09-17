import sharp from 'sharp';

import {
  expectRefusal,
  imageFixture,
  pixelAt,
  testContext,
} from './image-test-support';
import { JpegHandler } from './jpeg.handler';
import { PngHandler } from './png.handler';

describe('JpegHandler', () => {
  const handler = new JpegHandler();
  const png = new PngHandler();

  it('claims only JPEG bytes', () => {
    expect(handler.sniff(imageFixture('solid.jpg'))).toBe(true);
    expect(handler.sniff(imageFixture('solid.png'))).toBe(false);
  });

  it('owns the conventional jpg extension, not its format name', () => {
    expect(handler.format).toBe('jpeg');
    expect(handler.extension).toBe('jpg');
    expect(handler.mediaType).toBe('image/jpeg');
  });

  describe('decode', () => {
    it('reads a JPEG at its own dimensions', async () => {
      const image = await handler.decode(
        imageFixture('solid.jpg'),
        testContext(),
      );

      expect(image.width).toBe(64);
      expect(image.height).toBe(48);
    });

    /**
     * FR-009, the negative half: a JPEG has no transparency, so a fourth
     * channel here would be invented. Every JPEG→PNG result would then claim
     * an alpha channel it does not have.
     */
    it('invents no alpha channel', async () => {
      const image = await handler.decode(
        imageFixture('solid.jpg'),
        testContext(),
      );

      expect(image.hasAlpha).toBe(false);
      expect(image.channels).toBe(3);
      expect(image.data).toHaveLength(64 * 48 * 3);
    });

    /**
     * The dimension-preservation reading FR-008 and SC-002 actually mean: the
     * fixture *stores* 48x64 with orientation 6, and a viewer shows 64x48.
     * Comparing against the stored raster would fail for an image that
     * converted perfectly.
     */
    it('applies EXIF orientation to the pixels', async () => {
      const stored = await sharp(imageFixture('exif-rotated.jpg')).metadata();

      expect(stored.width).toBe(48);
      expect(stored.height).toBe(64);
      expect(stored.orientation).toBe(6);

      const image = await handler.decode(
        imageFixture('exif-rotated.jpg'),
        testContext(),
      );

      expect(image.width).toBe(64);
      expect(image.height).toBe(48);
    });

    /** One picture delivered in several passes is still one picture. */
    it('decodes a progressive JPEG to one complete image', async () => {
      const image = await handler.decode(
        imageFixture('progressive.jpg'),
        testContext(),
      );

      expect(image.width).toBe(64);
      expect(image.height).toBe(48);
      expect(image.data).toHaveLength(64 * 48 * 3);
    });

    it('surfaces bytes that are not an image as image_invalid', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('not-an-image.png'), testContext()),
        'image_invalid',
      );
    });

    it('refuses a declared pixel count over the budget', async () => {
      await expectRefusal(
        () =>
          handler.decode(
            imageFixture('solid.jpg'),
            testContext({ maxPixels: 100 }),
          ),
        'image_pixel_budget_exceeded',
      );
    });
  });

  describe('encode', () => {
    it('writes a valid JPEG at the source dimensions', async () => {
      const context = testContext();
      const decoded = await png.decode(imageFixture('solid.png'), context);
      const metadata = await sharp(
        await handler.encode(decoded, context),
      ).metadata();

      expect(metadata.format).toBe('jpeg');
      expect(metadata.width).toBe(64);
      expect(metadata.height).toBe(48);
    });

    /**
     * SC-003: the result is fully opaque, and the transparent regions are the
     * configured background — not black, which is what dropping the alpha
     * channel rather than compositing produces.
     */
    it('composites transparency onto the configured background', async () => {
      const context = testContext({ backgroundColor: '#ff0000' });
      const decoded = await png.decode(
        imageFixture('fully-transparent.png'),
        context,
      );

      expect(decoded.hasAlpha).toBe(true);

      const encoded = await handler.encode(decoded, context);
      const metadata = await sharp(encoded).metadata();

      expect(metadata.hasAlpha).toBe(false);
      expect(metadata.channels).toBe(3);

      const { data, info } = await sharp(encoded)
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Fully transparent everywhere, so every pixel is exactly the
      // background. JPEG is lossy, hence the tolerance.
      for (const [x, y] of [
        [0, 0],
        [info.width - 1, 0],
        [0, info.height - 1],
        [info.width - 1, info.height - 1],
      ]) {
        const [r, g, b] = pixelAt(data, info.width, info.channels, x, y);

        expect(r).toBeGreaterThan(240);
        expect(g).toBeLessThan(15);
        expect(b).toBeLessThan(15);
      }
    });

    it('leaves an already-opaque image visually unchanged', async () => {
      const context = testContext({ backgroundColor: '#00ff00' });
      const decoded = await handler.decode(imageFixture('solid.jpg'), context);
      const encoded = await handler.encode(decoded, context);
      const { data, info } = await sharp(encoded)
        .raw()
        .toBuffer({ resolveWithObject: true });

      // The background has no visible effect on an opaque source: the top-left
      // quadrant of the test card is (40, 60, 180), nowhere near pure green.
      const [r, g, b] = pixelAt(data, info.width, info.channels, 2, 2);

      expect(g).toBeLessThan(120);
      expect(Math.abs(r - 40)).toBeLessThan(20);
      expect(Math.abs(b - 180)).toBeLessThan(20);
    });

    /** Quality is configuration, never a request parameter. */
    it('encodes at the configured quality', async () => {
      const context = testContext();
      const decoded = await png.decode(imageFixture('solid.png'), context);

      const low = await handler.encode(
        decoded,
        testContext({
          jpegQuality: 10,
        }),
      );
      const high = await handler.encode(
        decoded,
        testContext({
          jpegQuality: 95,
        }),
      );

      expect(high.length).toBeGreaterThan(low.length);
      expect(handler.encode.length).toBe(2);
      expect(Object.keys(context.limits)).toContain('jpegQuality');
    });

    it('writes no metadata into the result', async () => {
      const context = testContext();
      const decoded = await handler.decode(
        imageFixture('exif-rotated.jpg'),
        context,
      );
      const metadata = await sharp(
        await handler.encode(decoded, context),
      ).metadata();

      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    });

    it('stops on an already-expired deadline', async () => {
      const context = testContext();
      const decoded = await png.decode(imageFixture('solid.png'), context);

      await expect(
        handler.encode(decoded, testContext({}, AbortSignal.abort())),
      ).rejects.toThrow();
    });
  });
});
