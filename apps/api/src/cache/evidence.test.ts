import type { SearchSpec } from '@chatagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { FetchOutcome } from '../fetch/types.js';
import { createProviderChain } from '../search/chain.js';
import type { SearchOutcome } from '../search/types.js';
import { createEvidenceCache } from './evidence.js';
import { contentHash, pageKey, searchKey, ttlMs } from './keys.js';
import { fallbackStore, memoryStore, type CacheStore } from './store.js';

const spec: SearchSpec = {
  query: 'Node docs',
  exactPhrases: [],
  includeDomains: ['nodejs.org'],
  excludeDomains: [],
  intent: 'official_docs',
  topic: 'general',
  volatility: 'fast',
};
const url = 'https://nodejs.org/docs';
const page = (text: string): FetchOutcome => ({
  ok: true,
  page: {
    url,
    title: 'Node',
    text,
    kind: 'html',
    retrievedAt: '2026-11-12T00:00:00.000Z',
  },
  revalidated: false,
});
const results: SearchOutcome = {
  ok: true,
  results: [
    {
      url,
      title: 'Node',
      snippet: 'Documentation',
      provider: 'tavily',
      rank: 1,
    },
  ],
};

describe('evidence cache', () => {
  it('reuses fresh paraphrase results across cache instances without spending search quota', async () => {
    const now = Date.now;
    const store = memoryStore();
    const set = vi.spyOn(store, 'set');
    const embedder = { modelKey: 'test', embed: vi.fn(async () => [[1, 0]]) };
    const backend = vi.fn(async () => results);
    const reserve = vi.fn(() => true);
    const chain = (model = embedder) =>
      createProviderChain(
        [
          {
            provider: { name: 'tavily', search: backend },
            quota: { bucket: 'tavily', units: 1 },
          },
        ],
        {
          meter: { reserve, snapshot: () => [] },
          failureThreshold: 2,
          cooldownMs: 1000,
          publicEvidenceCache: createEvidenceCache(store, now, model),
        },
      );
    const original = {
      ...spec,
      volatility: 'slow' as const,
      query: 'When was Portal 2 released?',
    };
    const rewrite = { ...original, query: 'When did Portal 2 come out?' };
    await chain().search(original);
    await vi.waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        expect.stringContaining(':semantic-search:'),
        expect.any(String),
        expect.any(Number),
      ),
    );
    expect(await chain().search(rewrite)).toEqual(results);
    expect(backend).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    await chain().search({ ...rewrite, includeDomains: ['example.org'] });
    await chain().search({ ...rewrite, query: 'When did Portal 1 come out?' });
    await chain().search({
      ...rewrite,
      query: 'When did Portal 2 not come out?',
    });
    await chain().search({ ...rewrite, volatility: 'fast' });
    await chain().search({ ...rewrite, recency: 'month' });
    await chain().search({
      ...rewrite,
      dateRange: { start: '2011-01-01', end: '2011-12-31' },
    });
    await chain({ ...embedder, modelKey: 'updated-model' }).search(rewrite);
    embedder.embed.mockResolvedValue([[0, 1]]);
    await chain().search({
      ...rewrite,
      query: 'What is the release date of Portal 2?',
    });
    expect(backend).toHaveBeenCalledTimes(9);
  });

  it('rejects stale neighbors and falls back when embeddings are unavailable', async () => {
    let time = 0;
    const store = memoryStore(128, () => time);
    const embedder = { modelKey: 'test', embed: vi.fn(async () => [[1, 0]]) };
    const cache = createEvidenceCache(store, () => time, embedder);
    const original = {
      ...spec,
      volatility: 'medium' as const,
      query: 'When was Portal 2 released?',
    };
    const backend = vi.fn(async () => results);
    await cache.search(original, 'tavily', backend);
    await new Promise((resolve) => setTimeout(resolve, 0));
    time = ttlMs('medium');
    const rewrite = { ...original, query: 'When did Portal 2 come out?' };
    expect(await cache.search(rewrite, 'tavily', backend)).toEqual(results);
    await new Promise((resolve) => setTimeout(resolve, 0));
    embedder.embed.mockRejectedValue(new Error('missing model'));
    expect(
      await cache.search(
        { ...rewrite, query: 'What is the release date of Portal 2?' },
        'tavily',
        backend,
      ),
    ).toEqual(results);
    expect(backend).toHaveBeenCalledTimes(3);
  });
  it('includes filters, provider and freshness in search keys', () => {
    const original = searchKey(spec, 'tavily', 0);
    for (const change of [
      { includeDomains: ['example.com'] },
      { excludeDomains: ['nodejs.org'] },
      { exactPhrases: ['node:test'] },
      { dateRange: { start: '2026-01-01', end: '2026-01-31' } },
      { recency: 'week' },
      { topic: 'news' },
      { intent: 'general' },
      { volatility: 'slow' },
    ] satisfies Partial<SearchSpec>[]) {
      expect(searchKey({ ...spec, ...change }, 'tavily', 0)).not.toBe(original);
    }
    expect(searchKey({ ...spec, query: '  Node   docs ' }, 'tavily', 0)).toBe(
      original,
    );
    expect(searchKey(spec, 'exa', 0)).not.toBe(original);
    expect(searchKey(spec, 'tavily', ttlMs('fast'))).not.toBe(original);
    expect(pageKey(url + '?utm_source=search#heading')).toBe(pageKey(url));
  });

  it('uses different retention periods for different volatility', async () => {
    const set = vi.fn<CacheStore['set']>(async () => {});
    const cache = createEvidenceCache({ get: async () => null, set }, () => 0);
    await cache.page(url, 'fast', async () => page('first'));
    await cache.page(url, 'slow', async () => page('second'));
    expect(set.mock.calls[0]![2]).toBeLessThan(set.mock.calls[1]![2]);
    expect(JSON.parse(set.mock.calls[0]![1]).freshUntil).toBe(ttlMs('fast'));
    expect(JSON.parse(set.mock.calls[1]![1]).freshUntil).toBe(ttlMs('slow'));
  });

  it('returns stale evidence immediately and coalesces background refresh', async () => {
    let now = 0;
    const cache = createEvidenceCache(
      memoryStore(10, () => now),
      () => now,
    );
    await cache.page(url, 'fast', async () => page('stale'));
    now = ttlMs('fast');
    let complete!: (outcome: FetchOutcome) => void;
    const refresh = vi.fn(
      () =>
        new Promise<FetchOutcome>((resolve) => {
          complete = resolve;
        }),
    );
    expect(
      await Promise.all([
        cache.page(url, 'fast', refresh),
        cache.page(url, 'fast', refresh),
      ]),
    ).toEqual([page('stale'), page('stale')]);
    expect(refresh).toHaveBeenCalledOnce();
    complete(page('fresh'));
    await vi.waitFor(async () =>
      expect(await cache.page(url, 'fast', refresh)).toEqual(page('fresh')),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('serves search hits before checking quota and coalesces simultaneous misses', async () => {
    const reserve = vi.fn(() => true);
    const search = vi.fn(async () => results);
    const chain = createProviderChain(
      [
        {
          provider: { name: 'tavily', search },
          quota: { bucket: 'tavily', units: 1 },
        },
      ],
      {
        meter: { reserve, snapshot: () => [] },
        failureThreshold: 2,
        cooldownMs: 1000,
        publicEvidenceCache: createEvidenceCache(memoryStore()),
      },
    );
    expect(await Promise.all([chain.search(spec), chain.search(spec)])).toEqual(
      [results, results],
    );
    reserve.mockReturnValue(false);
    expect(await chain.search(spec)).toEqual(results);
    expect(search).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('caches eligible negative results for a fixed period without refreshing them', async () => {
    let now = 0;
    const cache = createEvidenceCache(
      memoryStore(10, () => now),
      () => now,
    );
    const load = vi.fn(async (): Promise<FetchOutcome> => ({
      ok: false,
      error: 'paywall',
    }));
    expect(await cache.page(url, 'slow', load)).toEqual({
      ok: false,
      error: 'paywall',
    });
    now = ttlMs('negative') - 1;
    expect(await cache.page(url, 'fast', load)).toEqual({
      ok: false,
      error: 'paywall',
    });
    expect(load).toHaveBeenCalledOnce();
    now++;
    await cache.page(url, 'fast', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys extracted chunks and embeddings by content and strips answer or chat metadata', async () => {
    const set = vi.fn<CacheStore['set']>(async () => {});
    const local = memoryStore();
    const cache = createEvidenceCache({
      ...local,
      async set(...args) {
        await local.set(...args);
        await set(...args);
      },
    });
    const hash = contentHash('Evidence');
    const value = [
      {
        text: 'Evidence',
        finalAnswer: 'generated answer',
        chat: 'private conversation',
      },
    ];
    await cache.setChunks(url, hash, 'v1', value, 'slow');
    await cache.setEmbeddings(url, hash, 'model-v1', [[0.1, 0.3]], 'slow');
    expect(await cache.getChunks(url, hash, 'v1')).toEqual([
      { text: 'Evidence' },
    ]);
    expect(
      await cache.getChunks(url, contentHash('Changed'), 'v1'),
    ).toBeUndefined();
    expect(await cache.getEmbeddings(url, hash, 'model-v1')).toEqual([
      [0.1, 0.3],
    ]);
    expect(await cache.getEmbeddings(url, hash, 'model-v2')).toBeUndefined();
    const data = JSON.stringify(set.mock.calls);
    expect(data).not.toContain('generated answer');
    expect(data).not.toContain('private conversation');
    expect(cache).not.toHaveProperty('setAnswer');
  });

  it('uses the bounded LRU when Redis operations fail', async () => {
    const fail = async () => {
      throw new Error('offline');
    };
    const store = fallbackStore({ get: fail, set: fail }, memoryStore(2));
    await store.set('a', 'A', 1000);
    await store.set('b', 'B', 1000);
    expect(await store.get('a')).toBe('A');
    await store.set('c', 'C', 1000);
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBe('C');
  });
});
