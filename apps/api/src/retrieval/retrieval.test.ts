import { describe, expect, it, vi } from 'vitest';
import { createEvidenceCache } from '../cache/evidence.js';
import { memoryStore } from '../cache/store.js';
import { chunkText } from './chunker.js';
import { createRetriever, type Source } from './index.js';

const date = '2026-11-12T00:00:00Z';
const source = (
  url: string,
  text: string,
  title = 'Documentation',
): Source => ({ url, title, text, retrievedAt: date });
const docs = source(
  'https://nodejs.org/api/tls.html',
  'Ada Lovelace diagnosed ERR_TLS_CERT_ALTNAME_INVALID after moving to version 24.7.0.',
);
const distractor = source(
  'https://example.org/certs',
  'The certificate hostname was wrong. The client rejected the connection.',
);

describe('retrieval', () => {
  it('keeps a relevant separate page when one live blog has many matching chunks', async () => {
    const blog = source(
      'https://example.org/live',
      ['Board', 'Markets', 'Analysis', 'Reactions']
        .map(
          (heading) =>
            '# ' + heading + '\nAcme chief executive update. ' + heading,
        )
        .join('\n\n'),
      'Acme chief executive live updates',
    );
    const release = source(
      'https://acme.com/announcement',
      'Acme named its interim chief executive, Morgan Ellis.',
      'Appointment announcement',
    );
    const retrieve = createRetriever();
    const result = await retrieve({
      query: 'Acme chief executive',
      sources: [blog, release],
      topK: 3,
    });
    expect(result.ok && result.value.passages.map(({ url }) => url)).toContain(
      release.url,
    );
  });

  it.each(['Ada Lovelace', 'ERR_TLS_CERT_ALTNAME_INVALID', '24.7.0'])(
    'finds %s using exact lexical terms',
    async (query) => {
      const retrieve = createRetriever();
      expect(
        await retrieve({ query, sources: [distractor, docs], topK: 1 }),
      ).toMatchObject({
        ok: true,
        value: {
          embeddingUsed: false,
          passages: [
            { id: 'S1', url: docs.url, scores: { bm25: expect.any(Number) } },
          ],
        },
      });
    },
  );

  it('uses semantic matches for paraphrases and caches corpus vectors only', async () => {
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) =>
        text.includes('hostname') || text.includes('domain on my identity')
          ? [1, 0]
          : [0, 1],
      ),
    );
    const retrieve = createRetriever({
      embedder: { modelKey: 'mock-v1', embed },
      publicEvidenceCache: createEvidenceCache(memoryStore()),
    });
    const input = {
      query: 'wrong domain on my identity',
      sources: [docs, distractor],
      topK: 1,
    };
    expect(await retrieve(input)).toMatchObject({
      ok: true,
      value: {
        embeddingUsed: true,
        passages: [{ url: distractor.url, scores: { embedding: 1 } }],
      },
    });
    await retrieve(input);
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([1, 2, 1]);
  });

  it('keeps the higher-quality source when near-duplicate copies are syndicated', async () => {
    const article =
      'The example observatory announced a new telescope after several years of testing in remote regions. The research team will collect measurements of distant galaxies throughout the winter months and release the full dataset after independent review by the observatory committee.';
    const primary = source('https://nasa.gov/article', article);
    const copy = source(
      'https://reuters.com/article',
      article + ' A local reporter contributed to the story.',
    );
    const retrieve = createRetriever({ now: () => Date.parse(date) });
    const result = await retrieve({
      query: 'observatory telescope',
      sources: [copy, primary],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { passages: [{ id: 'S1', url: primary.url }] },
    });
    expect(
      await retrieve({
        query: 'observatory telescope',
        sources: [primary, copy],
      }),
    ).toEqual(result);
  });

  it('keeps near-duplicate pages with conflicting figures', async () => {
    const article =
      'The observatory published a report after collecting data during a long winter. Its research team measured objects across multiple regions using the same procedure. The final report gave a count of ';
    const sources = [
      source('https://nasa.gov/report', article + '12 galaxies.'),
      source('https://reuters.com/report', article + '18 galaxies.'),
    ];
    expect(
      await createRetriever()({ query: 'observatory report', sources }),
    ).toMatchObject({
      ok: true,
      value: {
        passages: [
          { text: expect.stringContaining('12 galaxies') },
          { text: expect.stringContaining('18 galaxies') },
        ],
      },
    });
  });

  it('reranks at most eight candidates and preserves lexical results if local models fail', async () => {
    const sources = Array.from({ length: 10 }, (_, index) =>
      source('https://example.org/' + index, 'Common item ' + index),
    );
    const score = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map((_, index) => index),
    );
    const embed = vi.fn(async () => {
      throw new Error('offline');
    });
    const retrieve = createRetriever({
      embedder: { embed, modelKey: 'offline' },
      reranker: { score },
    });
    const result = await retrieve({ query: 'common', sources });
    expect(score.mock.calls[0]![1]).toHaveLength(8);
    expect(result).toMatchObject({
      ok: true,
      value: {
        embeddingUsed: false,
        reranked: true,
        passages: [
          { id: 'S1', url: 'https://example.org/7' },
          ...Array(7).fill(expect.any(Object)),
        ],
      },
    });
  });

  it('splits large paragraphs with overlap and preserves heading boundaries', () => {
    const paragraph = Array.from(
      { length: 620 },
      (_, index) => 'word' + index,
    ).join(' ');
    const chunks = chunkText(
      '# Install\n' + paragraph + '\n\n## Configure\nKeep this separate.',
    );
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toMatchObject({
      heading: 'Install',
      text: expect.stringContaining('word279'),
    });
    expect(chunks[1]?.text.startsWith('word248')).toBe(true);
    expect(chunks.at(-1)).toEqual({
      heading: 'Configure',
      text: 'Keep this separate.',
    });
  });
});
