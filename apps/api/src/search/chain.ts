import { SearchSpecSchema, type SearchSpec } from '@chatagent/shared';
import type { EvidenceCache } from '../cache/evidence.js';
import { waitFor } from '../resilience/wait-for.js';
import { createBreaker } from '../resilience/breaker.js';
import type { QuotaBucket, QuotaMeter } from '../store/quota.js';
import { traceSpan } from '../telemetry/scope.js';
import type { SearchControl, SearchOutcome, SearchProvider } from './types.js';

interface SearchCandidate {
  provider: SearchProvider;
  quota?: { bucket: QuotaBucket; units: number };
}

export function createProviderChain(
  candidates: readonly SearchCandidate[],
  options: {
    meter: QuotaMeter;
    failureThreshold: number;
    cooldownMs: number;
    now?: () => number;
    publicEvidenceCache?: EvidenceCache;
  },
): SearchProvider {
  const providers = candidates.map(({ provider, quota }) => {
    const breaker = createBreaker(
      options.failureThreshold,
      options.cooldownMs,
      options.now ?? Date.now,
    );
    return {
      name: provider.name,
      async attempt(
        spec: SearchSpec,
        signal?: AbortSignal,
        control?: SearchControl,
      ): Promise<SearchOutcome> {
        if (signal?.aborted) return { ok: false, error: 'aborted' };
        const finish = breaker.enter();
        if (!finish) return { ok: false, error: 'circuit_open' };
        const release =
          quota && control ? control.reserveCredits(1) : undefined;
        if (quota && control && !release) {
          finish('neutral');
          return { ok: false, error: 'budget_exhausted' };
        }
        try {
          if (quota && !options.meter.reserve(quota.bucket, quota.units)) {
            release?.();
            finish('neutral');
            return { ok: false, error: 'quota_exhausted' };
          }
        } catch {
          release?.();
          finish('neutral');
          return { ok: false, error: 'quota_unavailable' };
        }
        let result: SearchOutcome;
        try {
          result = await traceSpan(
            'search',
            () => provider.search(spec, signal),
            {
              provider: provider.name,
              credits: quota ? 1 : 0,
              fallback: provider !== candidates[0]?.provider,
            },
            true,
          );
        } catch {
          result = { ok: false, error: 'unavailable' };
        }
        if (result.ok) finish('success');
        else if (result.error === 'rate_limit')
          finish('failure', result.retryAfterMs ?? options.cooldownMs);
        else
          finish(
            ['timeout', 'unavailable', 'invalid_response'].includes(
              result.error,
            )
              ? 'failure'
              : 'neutral',
          );
        return result;
      },
    };
  });

  return {
    name: 'search-chain',
    async search(input, signal, control) {
      const spec = SearchSpecSchema.safeParse(input);
      if (!spec.success) return { ok: false, error: 'invalid_spec' };
      let result: SearchOutcome = {
        ok: false,
        error: providers.length ? 'circuit_open' : 'unconfigured',
      };
      for (const { name, attempt } of providers) {
        if (signal?.aborted) return { ok: false, error: 'aborted' };
        const cache = options.publicEvidenceCache;
        const pending = cache
          ? cache.search(
              spec.data,
              name,
              () => attempt(spec.data, control ? signal : undefined, control),
              { refreshStale: !control },
            )
          : attempt(spec.data, signal, control);
        const outcome = await waitFor(pending, signal).catch(
          () => ({ ok: false, error: 'aborted' }) as const,
        );
        if (outcome.ok || outcome.error === 'aborted') return outcome;
        if (outcome.error !== 'circuit_open') result = outcome;
      }
      return signal?.aborted ? { ok: false, error: 'aborted' } : result;
    },
  };
}
