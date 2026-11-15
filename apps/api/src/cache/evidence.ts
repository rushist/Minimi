import {
  SearchResultSchema,
  SearchSpecSchema,
  type SearchSpec,
} from '@chatagent/shared';
import { z } from 'zod';
import { ExtractedPageSchema, type FetchOutcome } from '../fetch/types.js';
import type { SearchOutcome } from '../search/types.js';
import {
  chunkKey,
  embeddingKey,
  pageKey,
  searchKey,
  staleMs,
  ttlMs,
  type Volatility,
} from './keys.js';
import { singleFlight } from './single-flight.js';
import { createSemanticSearch } from './semantic-search.js';
import type { Embedder } from '../retrieval/types.js';
import type { CacheStore } from './store.js';
import { traceEvent } from '../telemetry/scope.js';

const maxEntryChars = 2_000_000;
const searchResults = z.array(SearchResultSchema);
const negative = z.enum(['timeout', 'paywall', 'forbidden']);
const pageEvidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), page: ExtractedPageSchema }),
  z.object({ kind: z.literal('negative'), error: negative }),
]);
const chunks = z.array(
  z.object({ text: z.string().min(1), heading: z.string().optional() }),
);
const embeddings = z.array(z.array(z.number().finite()).min(1));
const envelope = z.object({
  writtenAt: z.number().finite(),
  freshUntil: z.number().finite(),
  expiresAt: z.number().finite(),
  value: z.unknown(),
});

export function createEvidenceCache(
  store: CacheStore,
  now = Date.now,
  embedder?: Embedder,
) {
  const searchFlight = singleFlight<SearchOutcome>();
  const pageFlight = singleFlight<FetchOutcome>();
  const semantic = embedder && createSemanticSearch(store, embedder);

  async function read<S extends z.ZodType>(key: string, schema: S) {
    let cacheHit = false;
    const start = performance.now();
    try {
      const raw = await store.get(key);
      if (!raw || raw.length > maxEntryChars) return;
      const entry = envelope.safeParse(JSON.parse(raw));
      if (!entry.success || entry.data.expiresAt <= now()) return;
      const parsed = schema.safeParse(entry.data.value);
      if (parsed.success) {
        cacheHit = true;
        return { ...entry.data, value: parsed.data };
      }
    } catch {
      return;
    } finally {
      traceEvent(
        'cache',
        'lookup',
        { layer: key.split(':')[3] ?? 'unknown', cacheHit },
        performance.now() - start,
      );
    }
  }

  async function write<S extends z.ZodType>(
    key: string,
    schema: S,
    input: z.input<S>,
    fresh: number,
    stale = 0,
  ) {
    const value = schema.safeParse(input);
    if (!value.success) return;
    const writtenAt = now();
    try {
      const serialized = JSON.stringify({
        writtenAt,
        freshUntil: writtenAt + fresh,
        expiresAt: writtenAt + fresh + stale,
        value: value.data,
      });
      if (serialized.length <= maxEntryChars) {
        await store.set(key, serialized, fresh + stale);
      }
    } catch {
      // Cache availability does not change the evidence returned by the provider.
    }
  }

  return {
    async search(
      spec: SearchSpec,
      provider: string,
      load: () => Promise<SearchOutcome>,
      options: { refreshStale?: boolean } = {},
    ): Promise<SearchOutcome> {
      const parsed = SearchSpecSchema.safeParse(spec);
      if (!parsed.success) return { ok: false, error: 'invalid_spec' };
      const currentTime = now();
      const volatility = parsed.data.volatility;
      const ttl = ttlMs(volatility);
      const key = searchKey(parsed.data, provider, currentTime);
      const current = await read(key, searchResults);
      if (current && current.freshUntil > now())
        return { ok: true, results: current.value };
      const previous =
        current ??
        (await read(
          searchKey(parsed.data, provider, currentTime, true),
          searchResults,
        ));
      if (!previous && semantic) {
        const matches = await semantic.lookup(parsed.data, provider, key);
        for (const match of matches.slice(0, 2)) {
          const candidate = await read(match.key, searchResults);
          if (
            !candidate ||
            candidate.freshUntil <= now() ||
            !candidate.value.length
          )
            continue;
          traceEvent('cache', 'lookup', {
            layer: 'semantic-search',
            cacheHit: true,
            similarity: match.similarity,
          });
          return { ok: true, results: candidate.value };
        }
      }

      const refresh = () =>
        searchFlight(key, async () => {
          const result = await load();
          if (result.ok) {
            await write(
              key,
              searchResults,
              result.results,
              ttl,
              staleMs(volatility),
            );
            if (result.results.length)
              void semantic?.remember(parsed.data, provider, key);
          }
          return result;
        });
      if (previous && previous.expiresAt > now()) {
        if (options.refreshStale !== false) void refresh().catch(() => {});
        return { ok: true, results: previous.value };
      }
      return refresh();
    },

    async page(
      url: string,
      volatility: Volatility,
      load: () => Promise<FetchOutcome>,
      options: { refreshStale?: boolean } = {},
    ): Promise<FetchOutcome> {
      const key = pageKey(url);
      if (!key) return load();
      const current = await read(key, pageEvidence);
      if (current?.value.kind === 'negative')
        return { ok: false, error: current.value.error };
      const ttl = ttlMs(volatility);
      const stale = staleMs(volatility);
      if (
        current?.value.kind === 'page' &&
        Math.min(current.freshUntil, current.writtenAt + ttl) > now()
      ) {
        return { ok: true, page: current.value.page, revalidated: false };
      }
      const refresh = () =>
        pageFlight(key, async () => {
          const result = await load();
          if (result.ok)
            await write(
              key,
              pageEvidence,
              { kind: 'page', page: result.page },
              ttl,
              stale,
            );
          else if (
            (result.error !== 'timeout' || !current) &&
            negative.safeParse(result.error).success
          ) {
            const error = negative.parse(result.error);
            await write(
              key,
              pageEvidence,
              { kind: 'negative', error },
              ttlMs('negative'),
            );
          }
          return result;
        });
      if (
        current?.value.kind === 'page' &&
        Math.min(current.expiresAt, current.writtenAt + ttl + stale) > now()
      ) {
        if (options.refreshStale !== false) void refresh().catch(() => {});
        return { ok: true, page: current.value.page, revalidated: false };
      }
      return refresh();
    },

    async getChunks(url: string, hash: string, version: string) {
      const key = chunkKey(url, hash, version);
      return key ? (await read(key, chunks))?.value : undefined;
    },
    async setChunks(
      url: string,
      hash: string,
      version: string,
      value: z.input<typeof chunks>,
      volatility: Volatility,
    ) {
      const key = chunkKey(url, hash, version);
      if (key) await write(key, chunks, value, ttlMs(volatility));
    },
    async getEmbeddings(url: string, hash: string, model: string) {
      const key = embeddingKey(url, hash, model);
      return key ? (await read(key, embeddings))?.value : undefined;
    },
    async setEmbeddings(
      url: string,
      hash: string,
      model: string,
      value: z.input<typeof embeddings>,
      volatility: Volatility,
    ) {
      const key = embeddingKey(url, hash, model);
      if (key) await write(key, embeddings, value, ttlMs(volatility));
    },
  };
}

export type EvidenceCache = ReturnType<typeof createEvidenceCache>;
