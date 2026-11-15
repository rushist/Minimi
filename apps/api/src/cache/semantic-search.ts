import type { SearchSpec } from '@chatagent/shared';
import { z } from 'zod';
import { waitFor } from '../resilience/wait-for.js';
import { cosine } from '../retrieval/semantic.js';
import type { Embedder } from '../retrieval/types.js';
import { semanticSearchKey, ttlMs } from './keys.js';
import type { CacheStore } from './store.js';

const size = 8;
const threshold = 0.88;
const vector = z.array(z.number().finite()).min(1).max(2048);
const entries = z
  .array(
    z.object({
      key: z.string().regex(/^chatagent:evidence:v1:search:[a-f0-9]{64}$/),
      vector,
    }),
  )
  .max(size);
type Entries = z.infer<typeof entries>;

function anchors(spec: SearchSpec) {
  if (
    spec.topic !== 'general' ||
    spec.volatility === 'fast' ||
    spec.recency ||
    spec.query.length > 320 ||
    /[+#=]/.test(spec.query) ||
    /\b(?:today|tomorrow|yesterday|current|latest|recent|now|live|tonight|(?:this|last|next)\s+(?:week|month|year|quarter))\b/i.test(
      spec.query,
    )
  )
    return;
  // Keep names, ordered entities, numeric identifiers, negation and qualifiers.
  const query = spec.query
    .toLowerCase()
    .replace(
      /^what (?:is|was) (?:the )?release date (?:of|for) /,
      'when released ',
    )
    .replace(/^(when\b.*?)\b(?:come out|came out|release)\b/, '$1released');
  const words: string[] =
    query.match(/[\p{L}\p{N}]+(?:[.\-:/][\p{L}\p{N}]+)*/gu) ?? [];
  if (words[0] === 'when' && words.includes('released')) {
    words.splice(words.indexOf('released'), 1);
    words[0] = 'release-date';
    if (words[1] === 'was' || words[1] === 'did' || words[1] === 'were')
      words.splice(1, 1);
  }
  const signature = words.filter((word) => !/^(?:a|an|the|please)$/.test(word));
  return signature.length >= 2 ? signature.join(' ') : undefined;
}

export function createSemanticSearch(store: CacheStore, embedder: Embedder) {
  const writes = new Map<string, Promise<void>>();
  const embedding = new Map<string, Promise<number[] | undefined>>();

  function embed(query: string) {
    const cached = embedding.get(query);
    if (cached) return cached;
    if (embedding.size >= 8) return Promise.resolve(undefined);
    const work = Promise.resolve()
      .then(() => embedder.embed([query]))
      .then(([value]) => vector.safeParse(value).data)
      .catch(() => undefined)
      .finally(() => embedding.delete(query));
    embedding.set(query, work);
    return work;
  }

  async function read(key: string): Promise<Entries> {
    try {
      const value = await store.get(key);
      return value && value.length <= 600_000
        ? (entries.safeParse(JSON.parse(value)).data ?? [])
        : [];
    } catch {
      return [];
    }
  }

  function bucket(spec: SearchSpec, provider: string) {
    const signature = anchors(spec);
    return (
      signature &&
      semanticSearchKey(spec, provider, embedder.modelKey, signature)
    );
  }

  return {
    async lookup(spec: SearchSpec, provider: string, exactKey: string) {
      const key = bucket(spec, provider);
      if (!key) return [];
      return waitFor(
        (async () => {
          const alternatives = (await read(key)).filter(
            (entry) => entry.key !== exactKey,
          );
          if (!alternatives.length) return [];
          const queryVector = await embed(spec.query);
          if (!queryVector) return [];
          return alternatives
            .map((entry) => ({
              key: entry.key,
              similarity: cosine(entry.vector, queryVector),
            }))
            .filter((entry) => entry.similarity >= threshold)
            .sort((left, right) => right.similarity - left.similarity);
        })(),
        AbortSignal.timeout(400),
      ).catch(() => []);
    },

    remember(spec: SearchSpec, provider: string, exactKey: string) {
      const key = bucket(spec, provider);
      if (!key || (writes.size >= 8 && !writes.has(key))) return;
      const previous = writes.get(key);
      if (previous) return;
      const pending = (async () => {
        const queryVector = await embed(spec.query);
        if (!queryVector) return;
        const existing = await read(key);
        const next = [
          { key: exactKey, vector: queryVector },
          ...existing.filter((entry) => entry.key !== exactKey),
        ];
        await store.set(
          key,
          JSON.stringify(next.slice(0, size)),
          ttlMs(spec.volatility),
        );
      })()
        .catch(() => {})
        .finally(() => writes.delete(key));
      writes.set(key, pending);
      return pending;
    },
  };
}
