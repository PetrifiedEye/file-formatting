import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionFormat } from '@/modules/conversion/conversion.enums';
import { ConversionException } from '@/modules/conversion/conversion.exception';
import type { ConversionLimits } from '@/modules/conversion/formats/format-handler';

import { startDeadline } from './conversion-deadline';
import type { DocumentConversionTask } from './document-pipeline';
import { WorkerPoolDocumentConversionExecutor } from './worker-pool.executor';

const limits: ConversionLimits = {
  maxInputBytes: {
    [ConversionFormat.CSV]: 50_000_000,
    [ConversionFormat.JSON]: 50_000_000,
    [ConversionFormat.XML]: 50_000_000,
    [ConversionFormat.YAML]: 50_000_000,
  },
  maxOutputBytes: 200_000_000,
  maxDepth: 64,
  maxNodes: 50_000_000,
  maxCsvColumns: 1024,
  timeoutMs: 10_000,
  maxConcurrent: 2,
  maxQueue: 4,
};

function task(
  text: string,
  targetFormat: ConversionFormat,
  fileName = 'upload.json',
): DocumentConversionTask {
  return {
    text,
    fileName,
    sizeBytes: Buffer.byteLength(text),
    targetFormat,
    limits,
  };
}

/**
 * Real worker threads, loading the TypeScript worker through ts-node — the
 * same path the e2e suites take. Slow to start, so one pool serves the file.
 */
describe('WorkerPoolDocumentConversionExecutor', () => {
  jest.setTimeout(60_000);

  let executor: WorkerPoolDocumentConversionExecutor;

  beforeAll(() => {
    executor = new WorkerPoolDocumentConversionExecutor(limits);
  });

  afterAll(async () => {
    await executor.onModuleDestroy();
  });

  it('converts on a worker thread and hands back a Buffer', async () => {
    const outcome = await executor.run(
      task('[{"name":"Ann","age":"30"}]', ConversionFormat.CSV),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      ok: true,
      sourceFormat: ConversionFormat.JSON,
      mediaType: 'text/csv',
      extension: 'csv',
    });
    if (!outcome.ok) throw new Error('unreachable');
    expect(Buffer.isBuffer(outcome.output)).toBe(true);
    expect(Buffer.from(outcome.output).toString('utf8')).toBe(
      'name,age\r\nAnn,30\r\n',
    );
  });

  it('returns a refusal as data, with the detected format', async () => {
    const outcome = await executor.run(
      task('{"a":1}', ConversionFormat.JSON),
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      ok: false,
      code: ConversionErrorCode.SAME_FORMAT,
      params: {},
      sourceFormat: ConversionFormat.JSON,
    });
  });

  it('interrupts a parse already in progress when the deadline passes', async () => {
    // Big enough that `JSON.parse` + the walk + the write take well over the
    // budget: the point is that the task is stopped mid-way, which a
    // synchronous parse on the main thread cannot be.
    const rows = Array.from(
      { length: 400_000 },
      (_, index) => `{"id":${index},"name":"row-${index}","tags":["a","b"]}`,
    );
    const big = `[${rows.join(',')}]`;
    const deadline = startDeadline(50);

    const started = Date.now();
    const run = executor.run(task(big, ConversionFormat.YAML), deadline.signal);

    await expect(run).rejects.toBeInstanceOf(ConversionException);
    await expect(run).rejects.toMatchObject({
      code: ConversionErrorCode.TIMEOUT,
    });
    // Stopped near the budget, not after the conversion would have finished.
    expect(Date.now() - started).toBeLessThan(2_000);
    deadline.dispose();

    // The pool replaces the stopped worker and keeps serving.
    const next = await executor.run(
      task('[{"a":"1"}]', ConversionFormat.CSV),
      new AbortController().signal,
    );
    expect(next.ok).toBe(true);
  });
});
