import { ConversionException } from '@/modules/conversion/conversion.exception';

import { createRasterImage } from './raster-image';

const BUDGET = { maxPixels: 1000 };

function pixels(count: number, channels: number): Buffer {
  return Buffer.alloc(count * channels, 0x7f);
}

function expectRefusal(build: () => unknown, code: string): void {
  try {
    build();
    throw new Error('expected a refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionException);
    expect((error as ConversionException).code).toBe(code);
  }
}

describe('createRasterImage', () => {
  it('builds an opaque three-channel image', () => {
    const image = createRasterImage(
      {
        data: pixels(20 * 10, 3),
        width: 20,
        height: 10,
        channels: 3,
        hasAlpha: false,
      },
      BUDGET,
    );

    expect(image.width).toBe(20);
    expect(image.height).toBe(10);
    expect(image.channels).toBe(3);
    expect(image.hasAlpha).toBe(false);
  });

  it('builds a four-channel image carrying alpha', () => {
    const image = createRasterImage(
      {
        data: pixels(4, 4),
        width: 2,
        height: 2,
        channels: 4,
        hasAlpha: true,
      },
      BUDGET,
    );

    expect(image.hasAlpha).toBe(true);
    expect(image.data).toHaveLength(2 * 2 * 4);
  });

  it('refuses a buffer that does not match width x height x channels', () => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: pixels(4, 3),
            width: 2,
            height: 2,
            channels: 4,
            hasAlpha: true,
          },
          BUDGET,
        ),
      'image_invalid',
    );
  });

  it.each([
    [0, 10],
    [10, 0],
    [-1, 10],
  ])('refuses a %ix%i image', (width, height) => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: Buffer.alloc(0),
            width,
            height,
            channels: 3,
            hasAlpha: false,
          },
          BUDGET,
        ),
      'image_invalid',
    );
  });

  it('refuses a fractional dimension', () => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: pixels(6, 3),
            width: 2.5,
            height: 2,
            channels: 3,
            hasAlpha: false,
          },
          BUDGET,
        ),
      'image_invalid',
    );
  });

  it.each([1, 2, 5])('refuses %i channels', (channels) => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: pixels(4, channels),
            width: 2,
            height: 2,
            channels,
            hasAlpha: false,
          },
          BUDGET,
        ),
      'image_invalid',
    );
  });

  // Transparency that the buffer has no room for would be silently lost.
  it('refuses hasAlpha with three channels', () => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: pixels(4, 3),
            width: 2,
            height: 2,
            channels: 3,
            hasAlpha: true,
          },
          BUDGET,
        ),
      'image_invalid',
    );
  });

  it('refuses an image over the pixel budget', () => {
    expectRefusal(
      () =>
        createRasterImage(
          {
            data: pixels(101 * 10, 3),
            width: 101,
            height: 10,
            channels: 3,
            hasAlpha: false,
          },
          { maxPixels: 1000 },
        ),
      'image_pixel_budget_exceeded',
    );
  });

  it('accepts an image exactly at the budget', () => {
    expect(
      createRasterImage(
        {
          data: pixels(1000, 3),
          width: 100,
          height: 10,
          channels: 3,
          hasAlpha: false,
        },
        { maxPixels: 1000 },
      ).width,
    ).toBe(100);
  });

  /**
   * The structural half of FR-026: the hub has nowhere to put EXIF, a colour
   * profile, or any other embedded metadata, so none can cross it. If this
   * ever fails, "no image metadata is stored or logged" has gone from a shape
   * to a rule someone has to remember.
   */
  it('exposes no field capable of carrying metadata', () => {
    const image = createRasterImage(
      {
        data: pixels(1, 4),
        width: 1,
        height: 1,
        channels: 4,
        hasAlpha: true,
      },
      BUDGET,
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
