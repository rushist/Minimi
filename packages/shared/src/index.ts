import { z } from 'zod';

const count = z.number().int().nonnegative();
const url = z.url({ protocol: /^https?$/ });
const timestamp = z.iso.datetime({ offset: true });
const domain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
  );
const passageId = z.string().regex(/^S[1-9]\d*$/);

export const VolatilitySchema = z.enum(['fast', 'medium', 'slow']);
export const SearchSpecSchema = z
  .object({
    query: z.string().trim().min(1),
    exactPhrases: z.array(z.string().trim().min(1)).max(10),
    includeDomains: z.array(domain).max(10),
    excludeDomains: z.array(domain).max(10),
    recency: z.enum(['day', 'week', 'month', 'year']).optional(),
    dateRange: z
      .object({ start: z.iso.date(), end: z.iso.date() })
      .refine(
        ({ start, end }) => start <= end,
        'Start date must precede or equal end date',
      )
      .optional(),
    topic: z.enum(['general', 'news', 'finance']),
    intent: z.enum([
      'official_docs',
      'primary_source',
      'news',
      'discussion',
      'general',
    ]),
    volatility: VolatilitySchema,
  })
  .refine(
    ({ recency, dateRange }) => !(recency && dateRange),
    'Use either recency or a date range',
  );

export const SearchResultSchema = z.object({
  url,
  title: z.string(),
  snippet: z.string(),
  provider: z.string().min(1),
  publishedAt: timestamp.optional(),
  rank: count,
});

export const PassageSchema = z.object({
  id: passageId,
  url,
  domain,
  title: z.string(),
  text: z.string().min(1),
  publishedAt: timestamp.optional(),
  retrievedAt: timestamp,
  scores: z.object({
    bm25: z.number(),
    embedding: z.number(),
    fused: z.number(),
    sourceQuality: z.number(),
  }),
});

export const PlanSchema = z.object({
  route: z.enum(['no_search', 'quick', 'deep']),
  clarifyQuestion: z.string().min(1).optional(),
  assumption: z.string().min(1).optional(),
  standaloneQuery: z.string().min(1),
  subQuestions: z.array(z.string().min(1)).max(10),
  specs: z.array(SearchSpecSchema).max(3),
  answerShape: z.enum(['short', 'comparison', 'howto', 'timeline', 'list']),
  comparisonSubjects: z
    .array(z.string().min(1).max(160))
    .min(2)
    .max(8)
    .optional(),
});

export const ClaimSchema = z.object({
  id: z
    .string()
    .regex(/^C[1-9]\d*$/)
    .optional(),
  text: z.string().min(1),
  citedIds: z.array(passageId),
  verdict: z.enum(['supported', 'partial', 'unsupported', 'unchecked']),
  note: z.string().optional(),
});

export const MarketRangeSchema = z.enum(['1d', '1w', '1m', '1y', '5y', 'all']);
export type MarketRange = z.infer<typeof MarketRangeSchema>;
export const MarketQuoteSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  exchange: z.string(),
  currency: z.string(),
  price: z.number().positive(),
  timestamp,
  marketOpen: z.boolean().optional(),
});
export type MarketQuote = z.infer<typeof MarketQuoteSchema>;

export const AnswerResultSchema = z.object({
  status: z.enum(['complete', 'partial', 'abstained', 'clarification']),
  markdown: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  conflictingSources: z.boolean(),
  marketQuote: MarketQuoteSchema.optional(),
  basis: z.enum(['model', 'attachments', 'calculation']).optional(),
  claims: z.array(ClaimSchema),
  usage: z.object({ tokensUsed: count, llmCalls: count }),
});

export const TraceEventSchema = z.object({
  requestId: z.string().min(1),
  stage: z.string().min(1),
  type: z.string().min(1),
  ts: timestamp,
  durationMs: z.number().nonnegative().optional(),
  attrs: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});

export const BudgetSchema = z.object({
  maxLoops: count,
  maxSearches: count,
  maxPages: count,
  maxTokens: count,
  maxWallClockMs: count,
  searchCreditsUsed: count,
  llmCalls: count,
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), event: TraceEventSchema }),
  z.object({
    type: z.literal('token'),
    text: z.string(),
    provisional: z.boolean().optional(),
    claimId: z.string().optional(),
  }),
  z.object({ type: z.literal('sources'), passages: z.array(PassageSchema) }),
  z.object({ type: z.literal('citation'), id: passageId }),
  z.object({ type: z.literal('verification'), claim: ClaimSchema }),
  z.object({ type: z.literal('partial'), reason: z.string() }),
  z.object({ type: z.literal('abstain'), reason: z.string() }),
  z.object({
    type: z.literal('done'),
    requestId: z.string().min(1),
    answer: AnswerResultSchema.optional(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);

export type SearchSpec = z.infer<typeof SearchSpecSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type AnswerResult = z.infer<typeof AnswerResultSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;
