import { PlanSchema, SearchSpecSchema, type Plan } from '@chatagent/shared';
import { z } from 'zod';
import type { LLMError, LLMStats } from '../llm/types.js';

export const PlannerInputSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  summary: z.string().trim().max(3000).optional(),
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .max(24)
    .default([]),
  today: z.iso.date().optional(),
  webSearch: z.enum(['auto', 'on']).optional(),
  hasAttachments: z.boolean().optional(),
  visibility: z.enum(['public', 'private']).default('private'),
});
export type PlannerInput = z.input<typeof PlannerInputSchema>;
export type PlannerResult =
  | {
      ok: true;
      plan: Plan;
      stats: LLMStats;
      origin: 'local' | 'model' | 'fallback' | 'private';
      failure?: LLMError;
    }
  | { ok: false; error: 'invalid_input' | 'aborted' };

const draftSpec = z.object({
  ...SearchSpecSchema.shape,
  query: z.string().trim().min(1).max(4000),
  exactPhrases: z.array(z.string().trim().min(1).max(300)).max(24).default([]),
  includeDomains: z.array(z.string().max(253)).max(24).default([]),
  excludeDomains: z.array(z.string().max(253)).max(24).default([]),
  topic: SearchSpecSchema.shape.topic.default('general'),
  intent: SearchSpecSchema.shape.intent.default('general'),
  volatility: SearchSpecSchema.shape.volatility.default('medium'),
  recency: SearchSpecSchema.shape.recency
    .nullish()
    .transform((value) => value ?? undefined),
  dateRange: SearchSpecSchema.shape.dateRange
    .nullish()
    .transform((value) => value ?? undefined),
});
export const PlannerDraftSchema = z.object({
  ...PlanSchema.shape,
  clarifyQuestion: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .nullish()
    .transform((value) => value ?? undefined),
  assumption: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .nullish()
    .transform((value) => value ?? undefined),
  standaloneQuery: z.string().trim().min(1).max(4000),
  subQuestions: z.array(z.string().trim().min(1).max(500)).max(24).default([]),
  specs: z.array(draftSpec).max(10).default([]),
  answerShape: PlanSchema.shape.answerShape.default('short'),
});
export type PlannerDraft = z.output<typeof PlannerDraftSchema>;
