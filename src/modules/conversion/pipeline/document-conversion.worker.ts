/**
 * Worker-thread entry point for document conversions (run by Piscina).
 *
 * Builds its own registry from the same handler list the Nest module uses,
 * so the formats advertised and the formats converted cannot drift apart.
 * Nothing here touches the database, the network or the file system: a task
 * is text in, bytes (or a refusal) out.
 */
import 'reflect-metadata';

import { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { createFormatHandlers } from '@/modules/conversion/formats/format-handlers';
import type { ConversionLimits } from '@/modules/conversion/formats/format-handler';

import {
  runDocumentConversion,
  type DocumentConversionOutcome,
  type DocumentConversionTask,
} from './document-pipeline';

interface Pipeline {
  key: string;
  registry: FormatRegistryService;
  detector: FormatDetectorService;
}

let cached: Pipeline | undefined;

/** One registry per worker, rebuilt only if the limits ever differ. */
function pipelineFor(limits: ConversionLimits): Pipeline {
  const key = JSON.stringify(limits);

  if (cached?.key !== key) {
    const registry = new FormatRegistryService(createFormatHandlers(), limits);
    cached = { key, registry, detector: new FormatDetectorService(registry) };
  }

  return cached;
}

export default function convertDocument(
  task: DocumentConversionTask,
): Promise<DocumentConversionOutcome> {
  const { registry, detector } = pipelineFor(task.limits);

  // No signal: the deadline is enforced from the main thread, which stops
  // this worker outright — the only way to interrupt a synchronous parse.
  return runDocumentConversion(task, registry, detector);
}
