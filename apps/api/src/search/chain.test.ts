import type { SearchSpec } from '@chatagent/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openQuotaMeter } from '../store/quota.js';
import { readSearchEnv } from '../config/search.js';
import { configureSearch } from './index.js';
import { createProviderChain } from './chain.js';
import { fixtureTransport, httpTransport } from './transport.js';
import type { SearchProvider } from './types.js';

const spec: SearchSpec = {
  query: 'Node documentation',
  exactPhrases: [],
  includeDomains: [],
  excludeDomains: [],
  intent: 'official_docs',
  topic: 'general',
  volatility: 'slow',
};
const success = {
  ok: true,
  results: [
    {
      url: 'https://nodejs.org/',
      title: 'Node',
      snippet: 'Docs',
      rank: 1,
      provider: 'exa',
    },
  ],
} as const;

describe('provider chain', () => {
  it('falls back, accounts for failed calls, and skips the open primary until cooldown', async () => {
    const primary: SearchProvider = {
      name: 'tavily',
      search: vi.fn(async () => ({ ok: false, error: 'unavailable' })),
    };
    const fallback: SearchProvider = {
      name: 'exa',
      search: vi.fn(async () => ({
        ...success,
        results: [...success.results],
      })),
    };
    const { meter, close } = openQuotaMeter(
      ':memory:',
      { tavily: 2, exa: 40 },
      0.8,
    );
    try {
      let now = 0;
      const chain = createProviderChain(
        [
          { provider: primary, quota: { bucket: 'tavily', units: 1 } },
          { provider: fallback, quota: { bucket: 'exa', units: 10 } },
        ],
        { meter, failureThreshold: 1, cooldownMs: 30, now: () => now },
      );
      expect(await chain.search(spec)).toEqual(success);
      expect(await chain.search(spec)).toEqual(success);
      expect(primary.search).toHaveBeenCalledTimes(1);
      now = 31;
      expect(await chain.search(spec)).toEqual(success);
      expect(primary.search).toHaveBeenCalledTimes(2);
      expect(meter.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bucket: 'tavily',
            used: 2,
            nearLimit: true,
          }),
          expect.objectContaining({
            bucket: 'exa',
            used: 30,
            nearLimit: false,
          }),
        ]),
      );
      now = 62;
      expect(await chain.search(spec)).toEqual(success);
      expect(primary.search).toHaveBeenCalledTimes(2);
      expect(await chain.search(spec)).toEqual({
        ok: false,
        error: 'quota_exhausted',
      });
    } finally {
      close();
    }
  });

  it('persists quota across connections and resets only the expired period', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatagent-quota-'));
    const path = join(directory, 'quota.sqlite');
    let now = new Date('2026-01-01T12:00:00Z');
    const open = () =>
      openQuotaMeter(path, { tavily: 2, groq: 1 }, 0.8, () => now);
    try {
      const first = open();
      try {
        expect(first.meter.reserve('tavily', 2)).toBe(true);
        expect(first.meter.reserve('groq')).toBe(true);
      } finally {
        first.close();
      }
      const second = open();
      try {
        expect(second.meter.reserve('groq')).toBe(false);
        expect(second.meter.reserve('tavily')).toBe(false);
        now = new Date('2026-01-02T00:00:00Z');
        expect(second.meter.reserve('groq')).toBe(true);
        expect(second.meter.reserve('tavily')).toBe(false);
        now = new Date('2026-02-01T00:00:00Z');
        expect(second.meter.reserve('tavily')).toBe(true);
      } finally {
        second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('replays a recorded raw response without a network call or a quota charge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatagent-fixtures-'));
    const response = {
      results: [{ url: 'https://nodejs.org/', title: 'Node', content: 'Docs' }],
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network disabled'));
    const { meter, close } = openQuotaMeter(':memory:', {}, 0.8);
    try {
      const { tavily } = await import('./adapters.js');
      const { jsonTransport } = await import('./transport.js');
      const recording = fixtureTransport({
        mode: 'record',
        directory,
        upstream: httpTransport(fetcher),
      });
      const recorded = await tavily(
        'mock-key',
        jsonTransport(recording),
      ).search(spec);
      expect(recorded).toMatchObject({ ok: true });
      const config = readSearchEnv({
        SEARCH_MODE: 'replay',
        SEARCH_FIXTURE_DIR: directory,
      });
      const replay = configureSearch(config, meter);
      expect(await replay.search(spec)).toEqual(recorded);
      expect(
        await replay.search({ ...spec, includeDomains: ['example.com'] }),
      ).toEqual({ ok: false, error: 'fixture_missing' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(meter.snapshot().every(({ used }) => used === 0)).toBe(true);
    } finally {
      globalFetch.mockRestore();
      close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
