import { resolve } from 'node:path';
import type { Embedder, Reranker } from './types.js';

export function createLocalEmbedder(
  directory: string,
  revision: string,
): Embedder {
  let loading:
    | Promise<import('@huggingface/transformers').FeatureExtractionPipeline>
    | undefined;
  return {
    modelKey: revision + ':q8:mean',
    async embed(texts) {
      if (!texts.length) return [];
      const model = await (loading ??= import('@huggingface/transformers')
        .then(({ pipeline }) =>
          pipeline('feature-extraction', resolve(directory), {
            device: 'cpu',
            dtype: 'q8',
            local_files_only: true,
          }),
        )
        .catch((error: unknown) => {
          loading = undefined;
          throw error;
        }));
      const result: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += 16) {
        const tensor = await model(texts.slice(offset, offset + 16), {
          pooling: 'mean',
          normalize: true,
        });
        const width = tensor.dims[1];
        if (!width) throw new Error('Invalid embedding shape');
        const data = tensor.data;
        if (!(data instanceof Float32Array))
          throw new Error('Invalid embedding type');
        for (let start = 0; start < data.length; start += width)
          result.push(Array.from(data.subarray(start, start + width)));
      }
      return result;
    },
  };
}

async function loadReranker(directory: string) {
  const { AutoTokenizer, AutoModelForSequenceClassification } =
    await import('@huggingface/transformers');
  const path = resolve(directory);
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(path, { local_files_only: true }),
    AutoModelForSequenceClassification.from_pretrained(path, {
      device: 'cpu',
      dtype: 'q8',
      local_files_only: true,
    }),
  ]);
  return { tokenizer, model };
}

export function createLocalReranker(directory: string): Reranker {
  let loading: ReturnType<typeof loadReranker> | undefined;
  return {
    async score(query, passages) {
      const { tokenizer, model } = await (loading ??= loadReranker(
        directory,
      ).catch((error: unknown) => {
        loading = undefined;
        throw error;
      }));
      const input = tokenizer(
        passages.map(() => query),
        {
          text_pair: [...passages],
          padding: true,
          truncation: true,
          max_length: 384,
        },
      );
      const { logits } = await model(input);
      if (!(logits.data instanceof Float32Array))
        throw new Error('Invalid reranker output');
      return Array.from(logits.data);
    },
  };
}

export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [index, value] of a.entries()) {
    const other = b[index]!;
    dot += value * other;
    normA += value * value;
    normB += other * other;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
