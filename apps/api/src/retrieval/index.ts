import { PassageSchema, type Passage } from '@chatagent/shared';
import type { EvidenceCache } from '../cache/evidence.js';
import { contentHash } from '../cache/keys.js';
import { readRetrievalEnv } from '../config/retrieval.js';
import { canonicalUrl } from '../url.js';
import { chunkFormat, chunkText } from './chunker.js';
import { fingerprint, similar } from './dedupe.js';
import { lexicalRank } from './lexical.js';
import {
  cosine,
  createLocalEmbedder,
  createLocalReranker,
} from './semantic.js';
import { sourceQuality } from './source-quality.js';
import {
  RetrievalInputSchema,
  RetrievalOutputSchema,
  type Chunk,
  type Embedder,
  type Reranker,
  type RetrievalInput,
  type RetrievalResult,
  type Source,
} from './types.js';

export type { RetrievalInput, RetrievalResult, Source } from './types.js';

interface RetrievalOptions {
  embedder?: Embedder;
  reranker?: Reranker;
  publicEvidenceCache?: EvidenceCache;
  now?: () => number;
}

interface Group {
  source: Source;
  quality: number;
  hash: string;
  chunks: Chunk[];
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const validVectors = (vectors: number[][], count: number, width: number) =>
  vectors.length === count &&
  width > 0 &&
  vectors.every((row) => row.length === width && row.every(Number.isFinite));

function normalizeSources(
  sources: Source[],
  volatility: NonNullable<RetrievalInput['volatility']>,
  now: number,
) {
  const ranked = sources
    .flatMap((source) => {
      const url = canonicalUrl(source.url);
      if (
        !url ||
        !PassageSchema.shape.domain.safeParse(url.hostname.replace(/\.$/, ''))
          .success
      )
        return [];
      const quality = sourceQuality(source, volatility, now);
      return [
        {
          source: { ...source, url: url.href },
          quality,
          hash: contentHash(source.text),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.quality - a.quality ||
        compare(a.source.url, b.source.url) ||
        compare(a.hash, b.hash) ||
        compare(a.source.title, b.source.title),
    );

  const urls = new Set<string>();
  const fingerprints: ReturnType<typeof fingerprint>[] = [];
  return ranked.filter(({ source }) => {
    if (urls.has(source.url)) return false;
    urls.add(source.url);
    const next = fingerprint(source.text);
    if (fingerprints.some((existing) => similar(existing, next))) return false;
    fingerprints.push(next);
    return true;
  });
}

async function semanticRank(
  query: string,
  groups: Group[],
  options: RetrievalOptions,
  volatility: NonNullable<RetrievalInput['volatility']>,
) {
  const { embedder, publicEvidenceCache: cache } = options;
  if (!embedder || !groups.some(({ chunks }) => chunks.length))
    return undefined;
  try {
    const modelKey = embedder.modelKey + ':' + chunkFormat;
    const [vector] = await embedder.embed([query]);
    if (!vector || !validVectors([vector], 1, vector.length)) return undefined;
    const cached = await Promise.all(
      groups.map(async ({ source, hash, chunks }) => {
        const stored = await cache?.getEmbeddings(source.url, hash, modelKey);
        return stored && validVectors(stored, chunks.length, vector.length)
          ? stored
          : undefined;
      }),
    );
    const missing = groups.flatMap((group, index) =>
      cached[index] ? [] : group.chunks.map(({ text }) => text),
    );
    const embedded = missing.length ? await embedder.embed(missing) : [];
    if (!validVectors(embedded, missing.length, vector.length))
      return undefined;
    let offset = 0;
    const all = await Promise.all(
      groups.map(async ({ chunks, source, hash }, index) => {
        const hit = cached[index];
        if (hit) return hit;
        const rows = embedded.slice(offset, offset + chunks.length);
        offset += chunks.length;
        if (rows.length)
          await cache?.setEmbeddings(
            source.url,
            hash,
            modelKey,
            rows,
            volatility,
          );
        return rows;
      }),
    );
    return all
      .flat()
      .map((row, id) => ({ id, score: cosine(vector, row) }))
      .filter(({ score }) => score >= 0.2)
      .sort((a, b) => b.score - a.score || a.id - b.id);
  } catch {
    return undefined;
  }
}

export function createRetriever(options: RetrievalOptions = {}) {
  const now = options.now ?? Date.now;
  return async (input: RetrievalInput): Promise<RetrievalResult> => {
    const parsed = RetrievalInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_input' };
    const { query, sources, volatility, topK } = parsed.data;
    const cache = options.publicEvidenceCache;
    const groups: Group[] = await Promise.all(
      normalizeSources(sources, volatility, now()).map(async (group) => {
        const { source, hash } = group;
        const hit = await cache?.getChunks(source.url, hash, chunkFormat);
        if (hit) return { ...group, chunks: hit };
        const chunks = chunkText(source.text);
        await cache?.setChunks(
          source.url,
          hash,
          chunkFormat,
          chunks,
          volatility,
        );
        return { ...group, chunks };
      }),
    );
    const records = groups
      .flatMap((group) => group.chunks.map((chunk) => ({ group, chunk })))
      .map(({ group, chunk }, id) => ({
        group,
        chunk,
        id,
        title: group.source.title,
        heading: chunk.heading ?? '',
        text: chunk.text,
      }));
    const bm25 = lexicalRank(query, records);
    const semantic = await semanticRank(query, groups, options, volatility);
    const lexicalScores = new Map(
      bm25.map(({ id, score }, rank) => [id, { score, rank }]),
    );
    const semanticScores = new Map(
      semantic?.map(({ id, score }, rank) => [id, { score, rank }]),
    );

    const ranked = records
      .flatMap((record) => {
        const lexical = lexicalScores.get(record.id);
        const embedding = semanticScores.get(record.id);
        if (!lexical && !embedding) return [];
        const fused =
          ((lexical ? 1 / (61 + lexical.rank) : 0) +
            (embedding ? 1 / (61 + embedding.rank) : 0)) *
          (0.8 + 0.4 * record.group.quality);
        return [
          {
            ...record,
            scores: {
              bm25: lexical?.score ?? 0,
              embedding: embedding?.score ?? 0,
              fused,
              sourceQuality: record.group.quality,
            },
          },
        ];
      })
      .sort((a, b) => b.scores.fused - a.scores.fused || a.id - b.id);

    // Remove syndicated chunks before limiting the candidate list, keeping the best-ranked copy.
    const seen: { url: string; fingerprint: ReturnType<typeof fingerprint> }[] =
      [];
    const unique = ranked.filter(({ group, text }) => {
      const next = fingerprint(text);
      const url = group.source.url;
      if (
        seen.some((entry) =>
          entry.url !== url
            ? similar(entry.fingerprint, next)
            : entry.fingerprint.normalized === next.normalized &&
              entry.fingerprint.markers === next.markers,
        )
      )
        return false;
      seen.push({ url, fingerprint: next });
      return true;
    });
    let reranked = false;
    if (options.reranker && unique.length > 1) {
      const top = unique.slice(0, 8);
      try {
        const scores = await options.reranker.score(
          query,
          top.map(({ title, heading, text }) =>
            [title, heading, text].filter(Boolean).join('\n').slice(0, 1800),
          ),
        );
        if (scores.length === top.length && scores.every(Number.isFinite)) {
          const rerankedTop = top
            .map((record, index) => ({ record, score: scores[index]!, index }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map(({ record }) => record);
          unique.splice(0, top.length, ...rerankedTop);
          reranked = true;
        }
      } catch {
        // Local model failure leaves the fused ranking available.
      }
    }

    // Keep room for distinct pages before adding more chunks from a single page.
    const urls = new Set<string>();
    const diverse: typeof unique = [];
    const additional: typeof unique = [];
    for (const record of unique) {
      const url = record.group.source.url;
      (urls.has(url) ? additional : diverse).push(record);
      urls.add(url);
    }
    const passages: Passage[] = [...diverse, ...additional]
      .slice(0, topK)
      .map(({ group, text, heading, scores }, index) => ({
        id: 'S' + (index + 1),
        url: group.source.url,
        domain: new URL(group.source.url).hostname.replace(/\.$/, ''),
        title: group.source.title,
        text: heading ? heading + '\n\n' + text : text,
        retrievedAt: group.source.retrievedAt,
        publishedAt: group.source.publishedAt,
        scores,
      }));
    return {
      ok: true,
      value: RetrievalOutputSchema.parse({
        passages,
        embeddingUsed: semantic !== undefined,
        reranked,
      }),
    };
  };
}

export function configureRetriever(
  env: Record<string, string | undefined>,
  publicEvidenceCache?: EvidenceCache,
  embedder?: Embedder,
) {
  const config = readRetrievalEnv(env);
  return createRetriever({
    embedder:
      embedder ??
      createLocalEmbedder(
        config.RETRIEVAL_EMBEDDING_DIR,
        config.RETRIEVAL_EMBEDDING_REVISION,
      ),
    ...(config.RETRIEVAL_RERANK_ENABLED === 'true'
      ? { reranker: createLocalReranker(config.RETRIEVAL_RERANK_DIR) }
      : {}),
    ...(publicEvidenceCache ? { publicEvidenceCache } : {}),
  });
}
