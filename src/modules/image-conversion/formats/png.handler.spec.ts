import sharp from 'sharp';

import { expectRefusal, imageFixture, testContext } from './image-test-support';
import { PngHandler } from './png.handler';

describe('PngHandler', () => {
  const handler = new PngHandler();

  it('claims only PNG bytes', () => {
    expect(handler.sniff(imageFixture('solid.png'))).toBe(true);
    expect(handler.sniff(imageFixture('solid.jpg'))).toBe(false);
    expect(handler.sniff(Buffer.alloc(0))).toBe(false);
  });

  it('is both a source and a target', () => {
    expect(typeof handler.decode).toBe('function');
    expect(typeof handler.encode).toBe('function');
  });

  describe('decode', () => {
    it('reads a plain RGBA PNG at its own dimensions', async () => {
      const image = await handler.decode(
        imageFixture('solid.png'),
        testContext(),
      );

      expect(image.width).toBe(64);
      expect(image.height).toBe(48);
      expect(image.channels).toBe(4);
      expect(image.hasAlpha).toBe(true);
      expect(image.data).toHaveLength(64 * 48 * 4);
    });

    /**
     * Colour types a naive decoder refuses. All three come back as ordinary
     * 8-bit sRGB rather than as an error the caller would have to understand.
     */
    it.each([
      ['greyscale', 'greyscale.png', 40, 30],
      ['indexed-colour', 'indexed.png', 40, 30],
      ['16-bit-per-channel', 'sixteen-bit.png', 40, 30],
    ])('normalises a %s PNG to 8-bit', async (_kind, file, width, height) => {
      const image = await handler.decode(imageFixture(file), testContext());

      expect(image.width).toBe(width);
      expect(image.height).toBe(height);
      expect([3, 4]).toContain(image.channels);
      expect(image.data).toHaveLength(width * height * image.channels);
      // 8 bits per channel: one byte per channel per pixel, nothing wider.
      expect(image.data.length / (width * height)).toBe(image.channels);
    });

    it('keeps the alpha channel of a transparent PNG', async () => {
      const image = await handler.decode(
        imageFixture('transparent.png'),
        testContext(),
      );

      expect(image.hasAlpha).toBe(true);
      expect(image.channels).toBe(4);
      expect(image.data[3]).toBe(128);
    });

    it('surfaces a truncated file as image_invalid', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('truncated.png'), testContext()),
        'image_invalid',
      );
    });

    it('surfaces bytes that are not an image at all as image_invalid', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('not-an-image.png'), testContext()),
        'image_invalid',
      );
    });

    /**
     * The SC-007 mechanism, at the unit level: the file is 229 bytes and its
     * header declares 900 megapixels. It is refused from the header, so no
     * pixel buffer is ever allocated — and the refusal names the numbers
     * rather than leaking a library message.
     */
    it('refuses a declared pixel count over the budget, from the header', async () => {
      const bomb = imageFixture('pixel-bomb.png');

      expect(bomb.length).toBeLessThan(100 * 1024);

      await expectRefusal(
        () => handler.decode(bomb, testContext()),
        'image_pixel_budget_exceeded',
      );
    });

    it('refuses a real image over a tightened budget', async () => {
      await expectRefusal(
        () =>
          handler.decode(
            imageFixture('solid.png'),
            testContext({
              maxPixels: 100,
            }),
          ),
        'image_pixel_budget_exceeded',
      );
    });

    // No metadata field exists on the hub, so there is nothing to assert
    // about EXIF surviving — only that the pixels were oriented. That is the
    // JPEG handler's fixture; here it is enough that a PNG decodes upright.
    it('produces no metadata of any kind', async () => {
      const image = await handler.decode(
        imageFixture('solid.png'),
        testContext(),
      );

      expect(Object.keys(image).sort()).toEqual([
        'channels',
        'data',
        'hasAlpha',
        'height',
        'width',
      ]);
    });
  });

  describe('encode', () => {
    it('writes a valid PNG preserving alpha', async () => {
      const context = testContext();
      const decoded = await handler.decode(
        imageFixture('transparent.png'),
        context,
      );
      const encoded = await handler.encode(decoded, context);
      const metadata = await sharp(encoded).metadata();

      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(64);
      expect(metadata.height).toBe(48);
      expect(metadata.hasAlpha).toBe(true);
    });

    it('invents no alpha channel for an opaque source', async () => {
      const context = testContext();
      const decoded = await handler.decode(imageFixture('solid.jpg'), context);
      const encoded = await handler.encode(decoded, context);
      const metadata = await sharp(encoded).metadata();

      expect(metadata.hasAlpha).toBe(false);
      expect(metadata.channels).toBe(3);
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
      const decoded = await handler.decode(imageFixture('solid.png'), context);

      await expect(
        handler.encode(decoded, testContext({}, AbortSignal.abort())),
      ).rejects.toThrow();
    });
  });
});
