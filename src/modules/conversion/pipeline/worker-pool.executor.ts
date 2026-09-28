import { Logger, OnModuleDestroy } from '@nestjs/common';
import { extname, resolve } from 'path';
import { Piscina } from 'piscina';

import type { ConversionLimits } from '@/modules/conversion/formats/format-handler';

import type { DocumentConversionExecutor } from './document-conversion.executor';
import type {
  DocumentConversionOutcome,
  DocumentConversionTask,
} from './document-pipeline';

/** Idle workers above the minimum are stopped after this long. */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Runs document conversions in a pool of worker threads.
 *
 * Two things only a separate thread gives:
 *
 * - **The event loop stays free.** A 5 MiB `JSON.parse` no longer delays every
 *   unrelated request while it runs (SC-008).
 * - **The deadline can interrupt a parse already in progress.** Aborting the
 *   task stops its worker; the pool starts a fresh one for the next task.
 *
 * Admission is not decided here: `ConversionService` puts a
 * `ConcurrencyLimiter` sized to `maxConcurrent` in front, so the pool never
 * holds more tasks than it has threads and its own queue stays empty.
 */
export class WorkerPoolDocumentConversionExecutor
  implements DocumentConversionExecutor, OnModuleDestroy
{
  private readonly logger = new Logger(
    WorkerPoolDocumentConversionExecutor.name,
  );
  private readonly pool: Piscina<
    DocumentConversionTask,
    DocumentConversionOutcome
  >;

  constructor(limits: ConversionLimits) {
    this.pool = new Piscina({
      ...workerEntry(),
      minThreads: 1,
      maxThreads: limits.maxConcurrent,
      idleTimeout: IDLE_TIMEOUT_MS,
    });
  }

  async run(
    task: DocumentConversionTask,
    signal: AbortSignal,
  ): Promise<DocumentConversionOutcome> {
    try {
      return normalize(await this.pool.run(task, { signal }));
    } catch (error) {
      // Piscina rejects an aborted task with its own AbortError; the reason
      // the caller should see is the deadline's `timeout` refusal.
      if (signal.aborted) {
        throw signal.reason;
      }

      this.logger.error('Document conversion worker failed', error as Error);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }
}

/**
 * The worker module to load, and how.
 *
 * Built output (`dist/`) is plain JavaScript. Run from source — the unit and
 * e2e suites, through ts-jest — the worker is TypeScript, which a worker
 * thread cannot load by itself; it is given the same `ts-node` and
 * `tsconfig-paths` hooks the CLI scripts use.
 */
function workerEntry(): { filename: string; execArgv: string[] } {
  const extension = extname(__filename);
  const filename = resolve(__dirname, `document-conversion.worker${extension}`);

  if (extension !== '.ts') {
    return { filename, execArgv: [] };
  }

  return {
    filename,
    execArgv: [
      '--require',
      'ts-node/register/transpile-only',
      '--require',
      'tsconfig-paths/register',
    ],
  };
}

/** Structured clone turns the output `Buffer` into a plain `Uint8Array`. */
function normalize(
  outcome: DocumentConversionOutcome,
): DocumentConversionOutcome {
  if (!outcome.ok) {
    return outcome;
  }

  return {
    ...outcome,
    output: Buffer.from(
      outcome.output.buffer,
      outcome.output.byteOffset,
      outcome.output.byteLength,
    ),
  };
}
