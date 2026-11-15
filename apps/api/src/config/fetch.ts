import { z } from 'zod';
import type { EvidenceCache } from '../cache/evidence.js';
import type { Volatility } from '../cache/keys.js';
import { contentHash } from '../cache/keys.js';
import {
  captureArtifact,
  capturingArtifacts,
  traceSpan,
} from '../telemetry/scope.js';
import { waitFor } from '../resilience/wait-for.js';
import type { FetchOutcome } from '../fetch/types.js';
import { socketRenderer } from '../fetch/browser.js';
import { createPageFetcher, pageFetchPolicy } from '../fetch/index.js';

const browserConfig = z.object({
  FETCH_BROWSER_ENABLED: z.enum(['true', 'false']).default('false'),
  FETCH_RENDER_SOCKET: z.string().min(1).default('/renderer/browser.sock'),
});

export function configurePageFetcher(
  env: Record<string, string | undefined>,
  publicEvidenceCache?: EvidenceCache,
) {
  const config = browserConfig.parse(env);
  const fetchPage =
    config.FETCH_BROWSER_ENABLED === 'false'
      ? createPageFetcher()
      : createPageFetcher(
          { ...pageFetchPolicy, browserEnabled: true },
          {
            render: socketRenderer(
              config.FETCH_RENDER_SOCKET,
              pageFetchPolicy.maxBytes,
            ),
          },
        );

  return async (
    url: string,
    signal?: AbortSignal,
    volatility: Volatility = 'medium',
    options: { budgeted?: boolean } = {},
  ): Promise<FetchOutcome> => {
    return traceSpan(
      'fetch',
      async () => {
        if (signal?.aborted) return { ok: false, error: 'aborted' };
        const result = publicEvidenceCache
          ? await waitFor(
              publicEvidenceCache.page(
                url,
                volatility,
                () => fetchPage(url, options.budgeted ? signal : undefined),
                { refreshStale: !options.budgeted },
              ),
              signal,
            ).catch(() => ({ ok: false, error: 'aborted' }) as const)
          : await fetchPage(url, signal);
        if (result.ok && capturingArtifacts()) {
          captureArtifact('page_excerpt', {
            url: result.page.url,
            hash: contentHash(result.page.text),
            snippet: result.page.text.slice(0, 160),
          });
        }
        return result;
      },
      {},
      true,
    );
  };
}
