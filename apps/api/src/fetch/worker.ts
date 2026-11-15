import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { waitFor } from '../resilience/wait-for.js';
import { FetchFailure } from './types.js';

export type ExtractionInput =
  | {
      kind: 'html';
      data: Uint8Array | string;
      url: string;
      contentType: string;
    }
  | { kind: 'pdf'; data: Uint8Array; maxPages: number; maxTextChars: number };

const resultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({ title: z.string(), text: z.string() }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['paywall', 'extraction_failed']),
  }),
]);

export async function extractInWorker(
  input: ExtractionInput,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
    workerData: input,
    resourceLimits: { maxOldGenerationSizeMb: 96 },
    stdout: true,
    stderr: true,
    execArgv: [],
  });
  worker.stdout.resume();
  worker.stderr.resume();
  try {
    const message = await waitFor(
      new Promise<unknown>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', () =>
          reject(new FetchFailure('extraction_failed')),
        );
      }),
      signal,
    );
    const result = resultSchema.parse(message);
    if (!result.ok) throw new FetchFailure(result.error);
    return result.value;
  } finally {
    void worker.terminate();
  }
}
