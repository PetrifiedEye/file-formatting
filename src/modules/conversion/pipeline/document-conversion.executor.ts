import type { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import type { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';

import {
  runDocumentConversion,
  type DocumentConversionOutcome,
  type DocumentConversionTask,
} from './document-pipeline';

/**
 * Where a document conversion actually runs.
 *
 * `signal` is the conversion's deadline. An executor that honours it rejects
 * with `signal.reason` — the `timeout` refusal — once it aborts.
 */
export interface DocumentConversionExecutor {
  run(
    task: DocumentConversionTask,
    signal: AbortSignal,
  ): Promise<DocumentConversionOutcome>;
}

export const DOCUMENT_CONVERSION_EXECUTOR = Symbol(
  'DOCUMENT_CONVERSION_EXECUTOR',
);

/**
 * Runs the pipeline on the calling thread.
 *
 * The unit tests' executor, and the `CONVERSION_USE_WORKER_THREADS=false`
 * escape hatch. Its limit, stated plainly: a synchronous `JSON.parse` or
 * `yaml.parse` blocks the event loop while it runs and cannot be interrupted
 * once entered — the deadline is only noticed between stages. That is what
 * `WorkerPoolDocumentConversionExecutor` exists to fix.
 */
export class InProcessDocumentConversionExecutor implements DocumentConversionExecutor {
  constructor(
    private readonly registry: FormatRegistryService,
    private readonly detector: FormatDetectorService,
  ) {}

  run(
    task: DocumentConversionTask,
    signal: AbortSignal,
  ): Promise<DocumentConversionOutcome> {
    return runDocumentConversion(task, this.registry, this.detector, signal);
  }
}
