/** Raised by {@link ConcurrencyLimiter.acquire} when the wait queue is full. */
export class ConcurrencyQueueFullError extends Error {
  constructor(readonly maxQueue: number) {
    super(`Concurrency queue is full (${maxQueue} waiting)`);
    this.name = 'ConcurrencyQueueFullError';
  }
}

/** Releases a slot. Idempotent: a second call does nothing. */
export type ReleaseSlot = () => void;

/** The signal's reason — normally the caller's own error, e.g. a timeout. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;

  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

interface Waiter {
  grant: () => void;
  reject: (reason: unknown) => void;
}

/**
 * Admits at most `maxConcurrent` holders at once, queues up to `maxQueue` more
 * in arrival order, and refuses the rest.
 *
 * Three properties the hand-rolled semaphores it replaces did not have:
 *
 * - **The bound is exact.** A released slot is *handed* to the next waiter
 *   rather than returned to the pool for the waiter to re-take. Returning it
 *   first left a window — between the release and the waiter's resumption — in
 *   which any other caller could take the slot too, admitting
 *   `maxConcurrent + 1` (code-review FINDING 1).
 * - **Waiting honours the caller's deadline.** A waiter whose `signal` aborts
 *   leaves the queue at once, instead of holding its place until its turn and
 *   only then discovering it has expired.
 * - **The queue is bounded.** Past `maxQueue`, `acquire` fails fast with
 *   {@link ConcurrencyQueueFullError}, so a burst turns into quick refusals
 *   rather than an ever-growing backlog of requests that will time out anyway.
 */
export class ConcurrencyLimiter {
  private holders = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError('maxQueue must be a non-negative integer');
    }
  }

  /** Slots currently held. Never exceeds `maxConcurrent`. */
  get active(): number {
    return this.holders;
  }

  /** Callers waiting for a slot. Never exceeds `maxQueue`. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot, waiting in line if none is free.
   *
   * Rejects with `signal.reason` if the signal aborts first (or already has),
   * and with {@link ConcurrencyQueueFullError} if the line is full.
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    if (this.holders < this.maxConcurrent) {
      this.holders += 1;
      return Promise.resolve(this.releaser());
    }

    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new ConcurrencyQueueFullError(this.maxQueue));
    }

    return new Promise<ReleaseSlot>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(abortReason(signal!));
      };

      const waiter: Waiter = {
        // The slot arrives already counted: `release` hands it over without
        // ever decrementing, so there is no moment at which it looks free.
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
        reject,
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Run `task` in a slot, releasing it however the task ends. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);

    try {
      return await task();
    } finally {
      release();
    }
  }

  private releaser(): ReleaseSlot {
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.waiters.shift();

      if (next) {
        next.grant();
      } else {
        this.holders -= 1;
      }
    };
  }
}
