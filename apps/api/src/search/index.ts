import type { EvidenceCache } from '../cache/evidence.js';
import { type readSearchEnv, searchPolicy } from '../config/search.js';
import type { QuotaMeter } from '../store/quota.js';
import { createRedactor } from '../telemetry/redact.js';
import { exa, searxng, tavily } from './adapters.js';
import { createProviderChain } from './chain.js';
import { fixtureTransport, httpTransport, jsonTransport } from './transport.js';

export type { SearchControl, SearchOutcome, SearchProvider } from './types.js';

export function configureSearch(
  config: ReturnType<typeof readSearchEnv>,
  meter: QuotaMeter,
  publicEvidenceCache?: EvidenceCache,
  redact = createRedactor({
    TAVILY_API_KEY: config.TAVILY_API_KEY,
    EXA_API_KEY: config.EXA_API_KEY,
  }),
) {
  const directory = config.SEARCH_FIXTURE_DIR;
  const replay = config.SEARCH_MODE === 'replay';
  const transport = jsonTransport(
    replay
      ? fixtureTransport({ mode: 'replay', directory })
      : config.SEARCH_MODE === 'record'
        ? fixtureTransport({
            mode: 'record',
            directory,
            upstream: httpTransport(),
            redact,
          })
        : httpTransport(),
  );

  const candidates: Parameters<typeof createProviderChain>[0][number][] = [];
  if (replay) {
    candidates.push(
      { provider: tavily('', transport) },
      { provider: exa('', transport) },
    );
  } else {
    if (config.TAVILY_API_KEY) {
      if (!config.TAVILY_MONTHLY_CREDITS)
        throw new Error('Set TAVILY_MONTHLY_CREDITS when enabling Tavily');
      candidates.push({
        provider: tavily(config.TAVILY_API_KEY, transport),
        quota: { bucket: 'tavily', units: 1 },
      });
    }
    if (config.EXA_API_KEY) {
      const units = config.EXA_SEARCH_RESERVE_MICRODOLLARS;
      if (
        !config.EXA_MONTHLY_MICRODOLLARS ||
        !units ||
        units > config.EXA_MONTHLY_MICRODOLLARS
      )
        throw new Error(
          'Set valid Exa monthly and per-search quota amounts when enabling Exa',
        );
      candidates.push({
        provider: exa(config.EXA_API_KEY, transport),
        quota: { bucket: 'exa', units },
      });
    }
  }
  if (config.SEARXNG_URL)
    candidates.push({ provider: searxng(config.SEARXNG_URL, transport) });
  return createProviderChain(candidates, {
    ...searchPolicy,
    meter,
    ...(config.SEARCH_MODE === 'live' && publicEvidenceCache
      ? { publicEvidenceCache }
      : {}),
  });
}
