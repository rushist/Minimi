import { parentPort, workerData } from 'node:worker_threads';
import { FetchFailure } from './types.js';
import type { ExtractionInput } from './worker.js';

const input = workerData as ExtractionInput;
try {
  const value =
    input.kind === 'pdf'
      ? await (
          await import('./extract-pdf.js')
        ).extractPdf(input.data, input.maxPages, input.maxTextChars)
      : (await import('./extract-html.js')).extractHtml(
          input.data,
          input.url,
          input.contentType,
        );
  parentPort?.postMessage({ ok: true, value });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error:
      error instanceof FetchFailure && error.code === 'paywall'
        ? 'paywall'
        : 'extraction_failed',
  });
}
