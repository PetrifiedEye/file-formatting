import {
  ConcurrencyLimiter,
  ConcurrencyQueueFullError,
} from '@/core/concurrency/concurrency-limiter';
import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

/**
 * A conversion's time budget.
 *
 * The signal aborts with the `timeout` `ConversionException` itself as its
 * reason, so anything that honours it — the concurrency queue, an incremental
 * parser, a worker thread — fails with the code the caller should see rather
 * than a bare `AbortError`.
 */
export interface Deadline {
  signal: AbortSignal;
  /** Throws the `timeout` refusal once the budget is spent. */
  check(): void;
  dispose(): void;
}

export function startDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  const timeout = () =>
    new ConversionException(ConversionErrorCode.TIMEOUT, { limit: timeoutMs });
  const timer = setTimeout(() => controller.abort(timeout()), timeoutMs);

  return {
    signal: controller.signal,
    check: () => {
      if (controller.signal.aborted || Date.now() >= expiresAt) {
        throw timeout();
      }
    },
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Take a conversion slot under `deadline`.
 *
 * Waiters are subject to the same deadline as the work: queueing behind other
 * conversions must not buy a request extra time, and an expired waiter leaves
 * the queue at once. A full queue is the `service_busy` refusal.
 */
export async function acquireConversionSlot(
  limiter: ConcurrencyLimiter,
  deadline: Deadline,
): Promise<() => void> {
  try {
    return await limiter.acquire(deadline.signal);
  } catch (error) {
    if (error instanceof ConcurrencyQueueFullError) {
      throw new ConversionException(ConversionErrorCode.SERVICE_BUSY);
    }
    throw error;
  }
}
