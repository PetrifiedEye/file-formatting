import {
  ConcurrencyLimiter,
  ConcurrencyQueueFullError,
} from './concurrency-limiter';

/** A task that runs until the returned `finish` is called. */
function controllable() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

describe('ConcurrencyLimiter', () => {
  it('admits up to maxConcurrent at once and queues the rest in order', async () => {
    const limiter = new ConcurrencyLimiter(2, 10);
    const order: number[] = [];
    const gates = [1, 2, 3, 4].map(() => controllable());

    const runs = gates.map((gate, index) =>
      limiter.run(async () => {
        order.push(index);
        await gate.done;
      }),
    );

    await Promise.resolve();
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(2);
    expect(order).toEqual([0, 1]);

    gates[0].finish();
    await runs[0];
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(2);

    gates.forEach((gate) => gate.finish());
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(0);
  });

  /**
   * FINDING 1 of the code review, moved here from the review's failing spec.
   *
   *   1. A holds the only slot; B queues behind it.
   *   2. A releases. With a semaphore that decrements and then wakes B, B's
   *      increment only runs on the next microtask.
   *   3. C's continuation — already queued as a microtask — acquires first,
   *      sees a free slot and takes it.
   *   4. B resumes and increments anyway: maxConcurrent + 1 holders.
   *
   * Handing the slot to B directly leaves nothing for C to take.
   */
  it('never admits more than maxConcurrent, whatever the interleaving', async () => {
    const limiter = new ConcurrencyLimiter(1, 10);

    const releaseA = await limiter.acquire();
    const b = limiter.acquire();
    const c = Promise.resolve().then(() => limiter.acquire());

    releaseA();

    const releaseB = await b;
    expect(limiter.active).toBe(1);

    releaseB();
    const releaseC = await c;
    expect(limiter.active).toBe(1);

    releaseC();
    expect(limiter.active).toBe(0);
  });

  it('refuses fast once the queue is full', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);

    await limiter.acquire();
    const queued = limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(
      ConcurrencyQueueFullError,
    );
    expect(limiter.queued).toBe(1);

    void queued;
  });

  it('refuses at once with no queue at all', async () => {
    const limiter = new ConcurrencyLimiter(1, 0);

    await limiter.acquire();

    await expect(limiter.acquire()).rejects.toBeInstanceOf(
      ConcurrencyQueueFullError,
    );
  });

  describe('deadlines', () => {
    it('drops a waiter from the queue the moment its signal aborts', async () => {
      const limiter = new ConcurrencyLimiter(1, 5);
      const controller = new AbortController();
      const timeout = new Error('timed out');

      const release = await limiter.acquire();
      const waiting = limiter.acquire(controller.signal);
      expect(limiter.queued).toBe(1);

      controller.abort(timeout);

      await expect(waiting).rejects.toBe(timeout);
      expect(limiter.queued).toBe(0);

      // The slot goes back to the pool, not to the departed waiter.
      release();
      expect(limiter.active).toBe(0);
    });

    it('lets the next waiter in line through when one expires', async () => {
      const limiter = new ConcurrencyLimiter(1, 5);
      const expired = new AbortController();

      const release = await limiter.acquire();
      const first = limiter.acquire(expired.signal);
      const second = limiter.acquire();

      expired.abort(new Error('timed out'));
      await expect(first).rejects.toThrow('timed out');

      release();
      await expect(second).resolves.toEqual(expect.any(Function));
      expect(limiter.active).toBe(1);
    });

    it('refuses without queueing when the signal has already aborted', async () => {
      const limiter = new ConcurrencyLimiter(1, 5);
      const controller = new AbortController();
      controller.abort(new Error('too late'));

      await expect(limiter.acquire(controller.signal)).rejects.toThrow(
        'too late',
      );
      expect(limiter.active).toBe(0);
    });
  });

  it('releases the slot when the task fails', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);

    await expect(
      limiter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(limiter.active).toBe(0);
  });

  it('ignores a second release of the same slot', async () => {
    const limiter = new ConcurrencyLimiter(2, 1);

    const release = await limiter.acquire();
    await limiter.acquire();

    release();
    release();

    expect(limiter.active).toBe(1);
  });

  it.each([
    [0, 1],
    [1.5, 1],
    [1, -1],
  ])('rejects maxConcurrent=%s, maxQueue=%s', (maxConcurrent, maxQueue) => {
    expect(() => new ConcurrencyLimiter(maxConcurrent, maxQueue)).toThrow(
      RangeError,
    );
  });
});
