import { PlanSchema, type Claim, type Passage } from '@chatagent/shared';
import { z } from 'zod';
import type { LLMError } from '../llm/types.js';
import { ResearchOutputSchema } from '../researcher/index.js';

export const AnswerInputSchema = z.object({
  message: z.string().trim().min(1).max(4000).optional(),
  today: z.iso.date().optional(),
  plan: PlanSchema.refine(
    (plan) => JSON.stringify(plan).length <= 32_000,
    'Plan is too large',
  ),
  research: ResearchOutputSchema.refine(
    ({ passages }) =>
      new Set(passages.map(({ id }) => id)).size === passages.length,
    'Passage IDs must be unique',
  ),
  visibility: z.enum(['public', 'private']).default('private'),
});

export type AnswerInput = z.input<typeof AnswerInputSchema>;
export type AnswerShape = z.output<typeof PlanSchema>['answerShape'];

const claimDraft = z.object({
  kind: z.enum(['claim', 'conflict']),
  text: z.string().trim().min(1).max(650),
  citedIds: z
    .array(z.string().regex(/^S[1-9]\d*$/))
    .min(1)
    .max(5),
  label: z.string().trim().max(120).nullish(),
  column: z.number().int().min(1).max(8).optional(),
});
export const DraftRecordSchema = z.union([
  claimDraft,
  z.object({ kind: z.literal('abstain') }),
]);

export interface Draft {
  id: string;
  kind: 'claim' | 'conflict';
  text: string;
  citedIds: string[];
  label?: string;
  column?: number;
  cellValue?: string;
}

export interface VerifiedDraft {
  draft: Draft;
  claim: Claim;
  answeredQuestions?: number[];
  failure?: LLMError;
}

export type EvidenceIndex = ReadonlyMap<string, Passage>;

export interface AnswerContext {
  message: string;
  today: string;
  questions: readonly string[];
}
