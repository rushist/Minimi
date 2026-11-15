import { readFile } from 'node:fs/promises';
import type { SearchSpec } from '@chatagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { exa, searxng, tavily } from './adapters.js';
import type { SearchTransport } from './types.js';

const spec: SearchSpec = {
  query: 'Node documentation',
  exactPhrases: ['Node.js'],
  includeDomains: ['nodejs.org'],
  excludeDomains: ['blog.nodejs.org'],
  topic: 'news',
  intent: 'official_docs',
  volatility: 'medium',
  dateRange: { start: '2026-01-01', end: '2026-01-31' },
};

describe('search adapter contracts', () => {
  for (const name of ['tavily', 'exa', 'searxng'] as const) {
    it('maps filters and normalizes the ' + name + ' fixture', async () => {
      const body: unknown = JSON.parse(
        await readFile(
          new URL(
            '../../../../evals/fixtures/search/' + name + '.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const send = vi.fn<SearchTransport['send']>(async () => ({
        status: 200,
        body,
      }));
      const provider = { tavily, exa, searxng }[name](
        name === 'searxng' ? 'http://localhost:8888' : 'fake-key',
        { send },
      );
      expect(await provider.search(spec)).toMatchObject({
        ok: true,
        results: [
          {
            url: 'https://nodejs.org/docs?version=24',
            rank: 1,
            provider: name,
            publishedAt: '2026-01-15T00:00:00.000Z',
          },
        ],
      });
      const request = send.mock.calls[0]![0];
      if (name === 'tavily') {
        expect(request.body).toMatchObject({
          query: 'Node documentation "Node.js"',
          search_depth: 'basic',
          auto_parameters: false,
          include_domains: ['nodejs.org'],
          exclude_domains: ['blog.nodejs.org'],
          topic: 'news',
          start_date: '2026-01-01',
          end_date: '2026-01-31',
        });
      } else if (name === 'exa') {
        expect(request.body).toMatchObject({
          type: 'lite',
          includeDomains: ['nodejs.org'],
          excludeDomains: ['blog.nodejs.org'],
          startPublishedDate: '2026-01-01T00:00:00.000Z',
          endPublishedDate: '2026-01-31T23:59:59.999Z',
        });
      } else {
        expect(new URL(request.url).searchParams.get('format')).toBe('json');
      }
    });
  }
});
