import { PassageSchema, PlanSchema } from '@chatagent/shared';
import { z } from 'zod';

const count = z.number().int().nonnegative();
export const filterLocksSchema = z.object({
  exact: z.boolean().default(false),
  domains: z.boolean().default(false),
  dates: z.boolean().default(false),
});
export type FilterLocks = z.output<typeof filterLocksSchema>;
export const ResearchInputSchema = z.object({
  plan: PlanSchema.refine(
    (plan) => JSON.stringify(plan).length <= 32_000,
    'Plan is too large',
  ),
  message: z.string().trim().min(1).max(4000),
  visibility: z.enum(['public', 'private']).default('private'),
  filterLocks: filterLocksSchema.optional(),
  priorUsage: z.object({ tokens: count, llmCalls: count }).optional(),
});
export const CoverageSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  covered: z.boolean(),
  evidenceIds: z.array(z.string()),
  missing: z.string().optional(),
});
export const UsageSchema = z.object({
  loops: count,
  searches: count,
  pages: count,
  searchCreditsUsed: count,
  tokensUsed: count,
  llmCalls: count,
  elapsedMs: count,
});
export const ResearchReasonSchema = z.enum([
  'loops',
  'searches',
  'pages',
  'credits',
  'tokens',
  'wall_clock',
  'aborted',
  'quota',
  'search_rate_limit',
  'search_timeout',
  'search_rejected',
  'search_unavailable',
  'sufficiency_unavailable',
  'insufficient_evidence',
  'no_search',
  'private',
]);
const outcomeBase = z.object({
  degraded: z.boolean(),
  passages: z.array(PassageSchema).max(24),
  coverage: z.array(CoverageSchema).max(10),
  usage: UsageSchema,
});
export const ResearchOutputSchema = z.discriminatedUnion('status', [
  outcomeBase.extend({ status: z.literal('complete') }),
  outcomeBase.extend({
    status: z.literal('partial'),
    reason: ResearchReasonSchema,
  }),
  outcomeBase.extend({
    status: z.literal('skipped'),
    reason: z.enum(['private', 'no_search']),
  }),
]);
export type ResearchInput = z.input<typeof ResearchInputSchema>;
export type ResearchOutput = z.output<typeof ResearchOutputSchema>;
export type ResearchReason = z.output<typeof ResearchReasonSchema>;
export type Coverage = z.output<typeof CoverageSchema>;
export type ResearchResult =
  { ok: true; value: ResearchOutput } | { ok: false; error: 'invalid_input' };
