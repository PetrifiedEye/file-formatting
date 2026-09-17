import { ConversionException } from '@/modules/conversion/conversion.exception';

import { TEST_LIMITS } from './image-test-support';
import {
  parseViewBox,
  resolveIntrinsicSize,
  resolveLength,
} from './svg-intrinsic-size';

const LIMITS = {
  maxOutputWidth: TEST_LIMITS.maxOutputWidth,
  maxOutputHeight: TEST_LIMITS.maxOutputHeight,
  maxPixels: TEST_LIMITS.maxPixels,
};

function expectRefusal(
  attributes: Record<string, string>,
  code: string,
  limits = LIMITS,
): void {
  try {
    resolveIntrinsicSize(attributes, limits);
    throw new Error('expected a refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(ConversionException);
    expect((error as ConversionException).code).toBe(code);
  }
}

describe('resolveLength', () => {
  it.each([
    ['100', 100],
    ['100px', 100],
    ['  42  ', 42],
    ['1in', 96],
    ['0.5in', 48],
    ['72pt', 96],
    ['1pc', 16],
    ['25.4mm', 96],
    ['2.54cm', 96],
    ['1e2', 100],
  ])('resolves %s to %f CSS pixels', (value, expected) => {
    expect(resolveLength(value)).toBeCloseTo(expected, 6);
  });

  it('is case-insensitive about units', () => {
    expect(resolveLength('1IN')).toBe(96);
    expect(resolveLength('100PX')).toBe(100);
  });

  /**
   * Not "invalid" — these are legal SVG. They simply resolve against
   * something this rule does not have, so the `viewBox` has to supply the
   * dimension instead.
   */
  it.each(['1em', '2ex', '100%', 'auto', '', 'abc', '10 20'])(
    'does not resolve %s',
    (value) => {
      expect(resolveLength(value)).toBeNull();
    },
  );

  it('does not resolve a missing attribute', () => {
    expect(resolveLength(undefined)).toBeNull();
  });
});

describe('parseViewBox', () => {
  it.each([
    ['0 0 300 150', 300, 150],
    ['0,0,300,150', 300, 150],
    ['  -10  -10   40   20 ', 40, 20],
  ])('reads %s as %ix%i', (value, width, height) => {
    expect(parseViewBox(value)).toEqual({ width, height });
  });

  it.each([undefined, '', '0 0 300', '0 0 300 150 200', 'a b c d'])(
    'rejects %s',
    (value) => {
      expect(parseViewBox(value)).toBeNull();
    },
  );
});

describe('resolveIntrinsicSize', () => {
  /** Every worked example from contracts/image-rasterisation-rules.md §5. */
  it.each([
    [{ width: '100', height: '50' }, 100, 50],
    [{ width: '1in', height: '0.5in' }, 96, 48],
    [{ width: '10.2', height: '10.8' }, 11, 11],
    [{ width: '100%', height: '100%', viewBox: '0 0 300 150' }, 300, 150],
    [{ viewBox: '0 0 300 150' }, 300, 150],
    [{ width: '200', viewBox: '0 0 300 150' }, 200, 150],
  ])('resolves %o to %ix%i', (attributes, width, height) => {
    expect(resolveIntrinsicSize(attributes, LIMITS)).toEqual({ width, height });
  });

  /** Width and height are independent: each falls back on its own. */
  it('takes only the unresolved dimension from the viewBox', () => {
    expect(
      resolveIntrinsicSize({ height: '80', viewBox: '0 0 300 150' }, LIMITS),
    ).toEqual({ width: 300, height: 80 });
  });

  it('ceils rather than rounds, so a drawing is never clipped', () => {
    expect(
      resolveIntrinsicSize({ width: '10.01', height: '0.4' }, LIMITS),
    ).toEqual({ width: 11, height: 1 });
  });

  it('refuses a drawing sized by neither source', () => {
    expectRefusal({}, 'svg_no_intrinsic_size');
    expectRefusal({ width: '100%', height: '100%' }, 'svg_no_intrinsic_size');
    expectRefusal({ width: '100' }, 'svg_no_intrinsic_size');
  });

  it.each([
    [{ width: '0', height: '100' }],
    [{ width: '100', height: '0' }],
    [{ width: '-5', height: '100' }],
    [{ viewBox: '0 0 0 150' }],
  ])('refuses %o as having no intrinsic size', (attributes) => {
    expectRefusal(attributes, 'svg_no_intrinsic_size');
  });

  it('refuses a drawing over the configured maximum', () => {
    expectRefusal(
      { width: '99999', height: '99999' },
      'image_dimensions_exceeded',
    );
  });

  it.each([
    ['width', { width: '9000', height: '10' }],
    ['height', { width: '10', height: '9000' }],
  ])('refuses a drawing over the maximum %s', (_axis, attributes) => {
    expectRefusal(attributes, 'image_dimensions_exceeded');
  });

  it('refuses a drawing inside both axes but over the pixel budget', () => {
    expectRefusal(
      { width: '5000', height: '5000' },
      'image_dimensions_exceeded',
      {
        ...LIMITS,
        maxPixels: 1000000,
      },
    );
  });

  /** The check is against the size that will actually be produced. */
  it('checks the limit after ceiling, not before', () => {
    expectRefusal(
      { width: '8192.1', height: '10' },
      'image_dimensions_exceeded',
    );

    expect(
      resolveIntrinsicSize({ width: '8192', height: '10' }, LIMITS),
    ).toEqual({ width: 8192, height: 10 });
  });

  it('names the requested size and the permitted one', () => {
    try {
      resolveIntrinsicSize({ width: '99999', height: '99999' }, LIMITS);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as ConversionException).params).toEqual({
        width: 99999,
        height: 99999,
        maxWidth: 8192,
        maxHeight: 8192,
      });
    }
  });
});
