import { PassageSchema, VolatilitySchema } from '@chatagent/shared';
import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
export const SourceSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().max(1000),
  text: z.string().trim().min(1).max(100_000),
  retrievedAt: timestamp,
  publishedAt: timestamp.optional(),
});

export const RetrievalInputSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  sources: z.array(SourceSchema).max(32),
  volatility: VolatilitySchema.default('medium'),
  topK: z.number().int().min(1).max(24).default(8),
});
export const RetrievalOutputSchema = z.object({
  passages: z.array(PassageSchema).max(24),
  embeddingUsed: z.boolean(),
  reranked: z.boolean(),
});

export type Source = z.output<typeof SourceSchema>;
export type RetrievalInput = z.input<typeof RetrievalInputSchema>;
export type RetrievalOutput = z.output<typeof RetrievalOutputSchema>;
export type RetrievalResult =
  { ok: true; value: RetrievalOutput } | { ok: false; error: 'invalid_input' };

export interface Embedder {
  modelKey: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface Reranker {
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

export interface Chunk {
  text: string;
  heading?: string | undefined;
}
