import { renderAsync } from '@resvg/resvg-js';

import { expectRefusal, imageFixture, testContext } from './image-test-support';
import { SvgHandler } from './svg.handler';

/**
 * The renderer is a native module whose exports are non-configurable, so
 * `jest.spyOn` cannot wrap it. Mocking the module and delegating to the real
 * implementation keeps every assertion below running against actual
 * rasterisation while still recording whether it was reached at all — which is
 * the property the ordering tests need.
 */
jest.mock('@resvg/resvg-js', () => {
  const actual =
    jest.requireActual<typeof import('@resvg/resvg-js')>('@resvg/resvg-js');

  return { ...actual, renderAsync: jest.fn(actual.renderAsync) };
});

const render = renderAsync as jest.MockedFunction<typeof renderAsync>;
const realRender =
  jest.requireActual<typeof import('@resvg/resvg-js')>(
    '@resvg/resvg-js',
  ).renderAsync;

describe('SvgHandler', () => {
  const handler = new SvgHandler();

  beforeEach(() => {
    render.mockReset();
    render.mockImplementation(realRender);
  });

  it('claims only SVG documents', () => {
    expect(handler.sniff(imageFixture('valid-declared.svg'))).toBe(true);
    expect(handler.sniff(imageFixture('solid.png'))).toBe(false);
  });

  /**
   * The load-bearing absence. The registry computes directions from
   * capabilities, so with no `encode` here `png→svg` cannot be computed at
   * all — FR-003 is structural rather than a rule. Adding one would make
   * vectorisation representable, and this test is the tripwire.
   */
  it('exposes no encode, so vectorisation is unrepresentable', () => {
    expect(typeof handler.decode).toBe('function');
    expect((handler as { encode?: unknown }).encode).toBeUndefined();
    expect('encode' in handler).toBe(false);
  });

  describe('decode', () => {
    it('renders at the declared size', async () => {
      const image = await handler.decode(
        imageFixture('valid-declared.svg'),
        testContext(),
      );

      expect(image.width).toBe(120);
      expect(image.height).toBe(80);
      expect(image.channels).toBe(4);
      expect(image.data).toHaveLength(120 * 80 * 4);
    });

    it('derives the size from a viewBox alone', async () => {
      const image = await handler.decode(
        imageFixture('valid-viewbox-only.svg'),
        testContext(),
      );

      expect(image.width).toBe(300);
      expect(image.height).toBe(150);
    });

    it('takes each dimension from whichever source resolves it', async () => {
      const image = await handler.decode(
        imageFixture('valid-width-only.svg'),
        testContext(),
      );

      expect(image.width).toBe(200);
      expect(image.height).toBe(150);
    });

    it('converts units at 96 dpi', async () => {
      const image = await handler.decode(
        imageFixture('valid-inches.svg'),
        testContext(),
      );

      expect(image.width).toBe(96);
      expect(image.height).toBe(48);
    });

    /**
     * The renderer rounds a fractional dimension to nearest and would produce
     * 10x11 here. The rule ceils so a drawing is never clipped, and the
     * handler makes the output match the rule rather than letting the library
     * quietly redefine it.
     */
    it('honours the ceiling rule even where the renderer rounds', async () => {
      const image = await handler.decode(
        imageFixture('fractional.svg'),
        testContext(),
      );

      expect(image.width).toBe(11);
      expect(image.height).toBe(11);
      expect(image.data).toHaveLength(11 * 11 * 4);
    });

    it('renders over the configured background', async () => {
      const image = await handler.decode(
        imageFixture('valid-declared.svg'),
        testContext({ backgroundColor: '#ff0000' }),
      );

      // The drawing covers the whole canvas, so check a corner of a document
      // whose own paint stops short of it instead.
      const empty = await handler.decode(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
        ),
        testContext({ backgroundColor: '#ff0000' }),
      );

      expect([...empty.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
      expect(image.width).toBe(120);
    });
  });

  describe('the order of the checks', () => {
    /**
     * Nothing may be rendered for a document that fails validation or sizing.
     * Asserted against the renderer itself rather than by timing: if the spy
     * was never called, no drawing was rasterised.
     */
    it('renders nothing when validation fails', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('scripted.svg'), testContext()),
        'svg_active_content',
      );

      expect(render).not.toHaveBeenCalled();
    });

    it('renders nothing when the size cannot be determined', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('no-size.svg'), testContext()),
        'svg_no_intrinsic_size',
      );

      expect(render).not.toHaveBeenCalled();
    });

    /** FR-018: no rendering is performed for an oversized drawing. */
    it('renders nothing when the size exceeds the maximum', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('enormous.svg'), testContext()),
        'image_dimensions_exceeded',
      );

      expect(render).not.toHaveBeenCalled();
    });

    it('renders nothing for a zero-sized drawing', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('zero-size.svg'), testContext()),
        'svg_no_intrinsic_size',
      );

      expect(render).not.toHaveBeenCalled();
    });

    it('renders nothing for an external reference', async () => {
      await expectRefusal(
        () => handler.decode(imageFixture('remote-image.svg'), testContext()),
        'svg_external_reference',
      );

      expect(render).not.toHaveBeenCalled();
    });
  });

  describe('when the renderer fails', () => {
    it('reports svg_render_failed rather than the library message', async () => {
      render.mockRejectedValue(
        new Error('usvg: unexpected token near "<rect fill=..."'),
      );

      await expectRefusal(
        () => handler.decode(imageFixture('valid-declared.svg'), testContext()),
        'svg_render_failed',
      );
    });

    it('leaves an aborted render as an abort, not a render failure', async () => {
      const controller = new AbortController();
      const abort = new Error('AbortError');

      render.mockImplementation(() => {
        controller.abort();
        return Promise.reject(abort);
      });

      await expect(
        handler.decode(
          imageFixture('valid-declared.svg'),
          testContext({}, controller.signal),
        ),
      ).rejects.toBe(abort);
    });
  });

  it('stops on an already-expired deadline before rendering', async () => {
    await expect(
      handler.decode(
        imageFixture('valid-declared.svg'),
        testContext({}, AbortSignal.abort()),
      ),
    ).rejects.toThrow();

    expect(render).not.toHaveBeenCalled();
  });
});
