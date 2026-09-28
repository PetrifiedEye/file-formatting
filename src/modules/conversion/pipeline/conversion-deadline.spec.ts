import { ConcurrencyLimiter } from '@/core/concurrency/concurrency-limiter';
import { ConversionException } from '@/modules/conversion/conversion.exception';

import { acquireConversionSlot, startDeadline } from './conversion-deadline';

describe('conversion deadline', () => {
  it('passes its check while there is time left', () => {
    const deadline = startDeadline(10_000);

    expect(() => deadline.check()).not.toThrow();
    expect(deadline.signal.aborted).toBe(false);
    deadline.dispose();
  });

  it('aborts with the timeout refusal itself as the reason', async () => {
    const deadline = startDeadline(5);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(ConversionException);
    expect(deadline.signal.reason).toMatchObject({
      code: 'timeout',
      params: { limit: 5 },
    });
    expect(() => deadline.check()).toThrow(
      expect.objectContaining({ code: 'timeout' }) as never,
    );
    deadline.dispose();
  });

  it('stops its timer when disposed', async () => {
    const deadline = startDeadline(5);
    deadline.dispose();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deadline.signal.aborted).toBe(false);
  });

  describe('acquireConversionSlot', () => {
    it('reports a full queue as service_busy', async () => {
      const limiter = new ConcurrencyLimiter(1, 0);
      const deadline = startDeadline(10_000);
      await limiter.acquire();

      await expect(
        acquireConversionSlot(limiter, deadline),
      ).rejects.toMatchObject({ code: 'service_busy' });
      deadline.dispose();
    });

    it('reports a wait that outlives the deadline as a timeout', async () => {
      const limiter = new ConcurrencyLimiter(1, 1);
      const deadline = startDeadline(5);
      await limiter.acquire();

      await expect(
        acquireConversionSlot(limiter, deadline),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(limiter.queued).toBe(0);
      deadline.dispose();
    });
  });
});
