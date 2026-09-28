import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionFormat } from '@/modules/conversion/conversion.enums';
import {
  ConversionErrorParams,
  ConversionException,
} from '@/modules/conversion/conversion.exception';
import type { FormatDetectorService } from '@/modules/conversion/detection/format-detector.service';
import type { FormatRegistryService } from '@/modules/conversion/detection/format-registry.service';
import { guardStructure } from '@/modules/conversion/formats/document-node';
import type { ConversionLimits } from '@/modules/conversion/formats/format-handler';

/**
 * Everything a conversion needs, as plain data — it crosses to a worker
 * thread by structured clone.
 */
export interface DocumentConversionTask {
  /** The upload, already UTF-8-validated and BOM-stripped. */
  text: string;
  /** The uploaded name: its extension is detection's tie-breaker (FR-003). */
  fileName: string;
  /** Bytes received, for the detected format's own limit (FR-016). */
  sizeBytes: number;
  targetFormat: ConversionFormat;
  limits: ConversionLimits;
}

/**
 * The result, also as plain data. A refusal is a value rather than a thrown
 * `ConversionException`, whose prototype would not survive the thread
 * boundary; the caller rebuilds the exception from `code` and `params`.
 * `sourceFormat` is carried either way, so a refusal after detection is
 * recorded against the format the file turned out to be.
 */
export type DocumentConversionOutcome =
  | {
      ok: true;
      output: Uint8Array;
      sourceFormat: ConversionFormat;
      mediaType: string;
      extension: string;
    }
  | {
      ok: false;
      code: ConversionException['code'];
      params: ConversionErrorParams;
      sourceFormat: ConversionFormat | null;
    };

/**
 * Detect → apply the detected format's limit → read → guard → write, in the
 * order the contract fixes. Pure: the same function runs on the main thread
 * and in a worker.
 *
 * Detection's confirming parse *is* the read. The model it produced is
 * converted directly, so a document is parsed once, not twice (FINDING 4) —
 * and that parse now happens under the conversion's deadline and concurrency
 * bound rather than before either applies.
 *
 * The result is serialized **completely** before anything is returned, which
 * is what makes a partial file unrepresentable (FR-008).
 */
export async function runDocumentConversion(
  task: DocumentConversionTask,
  registry: FormatRegistryService,
  detector: FormatDetectorService,
  signal?: AbortSignal,
): Promise<DocumentConversionOutcome> {
  const { limits } = task;
  let sourceFormat: ConversionFormat | null = null;

  try {
    const identified = await detector.identify(
      { text: task.text, prefix: task.text },
      limits,
      task.fileName,
      signal,
    );
    sourceFormat = identified.format;
    throwIfAborted(signal);

    // FR-016: the limit that applies is the *detected* format's, which is why
    // the same byte count can be accepted as XML and refused as CSV.
    const applicable = registry.maxInputBytesFor(sourceFormat);
    if (task.sizeBytes > applicable) {
      throw new ConversionException(ConversionErrorCode.INPUT_TOO_LARGE, {
        limit: applicable,
      });
    }

    // A bad request, not a 415: both formats are supported.
    if (sourceFormat === task.targetFormat) {
      throw new ConversionException(ConversionErrorCode.SAME_FORMAT);
    }

    const source = registry.requireHandler(
      sourceFormat,
      ConversionErrorCode.UNSUPPORTED_SOURCE_FORMAT,
    );
    const target = registry.requireHandler(
      task.targetFormat,
      ConversionErrorCode.UNSUPPORTED_TARGET_FORMAT,
    );

    const context = { limits, signal };

    const model = identified.model ?? (await source.read(task.text, context));
    throwIfAborted(signal);

    // One shared walk, whatever format produced the model.
    guardStructure(model, limits);

    const output = await target.write(model, context);
    throwIfAborted(signal);

    if (output.length > limits.maxOutputBytes) {
      throw new ConversionException(ConversionErrorCode.OUTPUT_TOO_LARGE, {
        limit: limits.maxOutputBytes,
      });
    }

    return {
      ok: true,
      output,
      sourceFormat,
      mediaType: target.mediaType,
      extension: target.extension,
    };
  } catch (error) {
    if (error instanceof ConversionException) {
      return {
        ok: false,
        code: error.code,
        params: error.params,
        sourceFormat,
      };
    }

    throw error;
  }
}

/**
 * The CSV reader stops early on abort and returns what it has, so a partial
 * model must never be taken for a whole one: stop here instead.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason;
  }
}
