import { randomUUID } from 'node:crypto';
import {
  AnswerResultSchema,
  type AnswerResult,
  type StreamEvent,
} from '@chatagent/shared';
import type { LLMProvider } from '../llm/index.js';
import { modelFailureMessage } from '../llm/diagnostics.js';
import { userFilters } from '../planner/filters.js';
import type { ResearchOutput } from '../researcher/index.js';
import { createAnswerBudget, type AnswerBudget } from './budget.js';
import { balanceComparisonPassages } from './comparison.js';
import { groupPassagesBySource, preparePassages } from './evidence.js';
import { extractSourceEvidence } from './extractive.js';
import {
  comparisonTable,
  escapeMarkdown,
  renderAbstention,
  renderClaim,
} from './shapes.js';
import { synthesize, type DraftEvent } from './synthesizer.js';
import {
  AnswerInputSchema,
  type AnswerContext,
  type AnswerInput,
  type AnswerShape,
  type Draft,
  type EvidenceIndex,
  type VerifiedDraft,
} from './types.js';
import { unverifiedDrafts, verifyDrafts } from './verifier.js';

export type { AnswerInput } from './types.js';

type AnswerLLM = Pick<LLMProvider, 'stream' | 'generateStructured'>;
type DraftEnd = Extract<DraftEvent, { type: 'end' }>;
const unknownEnd: DraftEnd = {
  type: 'end',
  invalid: true,
  abstained: false,
  limited: false,
};
interface PipelineResult {
  verified: VerifiedDraft[];
  end: DraftEnd;
}

function* claimEvents(
  draft: Draft,
  shape: AnswerShape,
  index: number,
): Generator<StreamEvent> {
  yield {
    type: 'token',
    text: renderClaim(draft, shape, index),
    claimId: draft.id,
  };
  for (const id of draft.citedIds) yield { type: 'citation', id };
}

async function runVerifiedAnswer(
  stream: AsyncGenerator<DraftEvent>,
  llm: AnswerLLM,
  evidence: EvidenceIndex,
  budget: AnswerBudget,
  requestId: string,
  answerContext: AnswerContext,
  repair?: {
    columns: number;
    run: (
      start: number,
      missingColumns: number[],
      existingAspects: string[],
    ) => AsyncGenerator<DraftEvent>;
  },
  repairQuestions?: (
    start: number,
    questions: string[],
  ) => AsyncGenerator<DraftEvent>,
): Promise<PipelineResult> {
  const drafts: Draft[] = [];
  let end = unknownEnd;
  for await (const event of stream) {
    if (event.type === 'draft') drafts.push(event.draft);
    else end = event;
  }
  const verified = await verifyClaims(
    drafts,
    llm,
    evidence,
    budget,
    requestId,
    answerContext,
  );
  const missing = Array.from(
    { length: repair?.columns ?? 0 },
    (_, index) => index + 1,
  ).filter(
    (column) =>
      !verified.some(
        ({ draft, claim }) =>
          draft.column === column && claim.verdict === 'supported',
      ),
  );
  if (
    repair &&
    missing.length &&
    drafts.length < 10 &&
    !budget.signal.aborted &&
    budget.remainingMs() >= 6500 &&
    !end.failure &&
    verified.every(({ failure }) => !failure)
  ) {
    const extra: Draft[] = [];
    const existingAspects = [
      ...new Set(
        verified.flatMap(({ draft, claim }) =>
          claim.verdict === 'supported' && draft.label ? [draft.label] : [],
        ),
      ),
    ];
    for await (const event of repair.run(
      drafts.length,
      missing,
      existingAspects,
    )) {
      if (event.type === 'draft') extra.push(event.draft);
      else if (!drafts.length) {
        const failure = event.failure ?? end.failure;
        end = failure ? { ...event, failure } : event;
      }
    }
    verified.push(
      ...(await verifyClaims(
        extra,
        llm,
        evidence,
        budget,
        requestId,
        answerContext,
      )),
    );
  }
  if (
    !repair &&
    repairQuestions &&
    answerContext.questions.length > 1 &&
    verified.some(
      ({ claim, answeredQuestions }) =>
        claim.verdict === 'supported' && answeredQuestions?.length,
    ) &&
    drafts.length < 10 &&
    !end.failure &&
    budget.remainingMs() >= 7500 &&
    verified.every(({ failure }) => !failure)
  ) {
    const covered = new Set(
      verified.flatMap(({ claim, answeredQuestions }) =>
        claim.verdict === 'supported' ? (answeredQuestions ?? []) : [],
      ),
    );
    const missing = answerContext.questions.filter(
      (_, index) => !covered.has(index + 1),
    );
    if (missing.length) {
      const extra: Draft[] = [];
      const existing = new Set(drafts.map((draft) => draft.text));
      for await (const event of repairQuestions(drafts.length, missing)) {
        if (event.type === 'draft' && !existing.has(event.draft.text))
          extra.push(event.draft);
      }
      verified.push(
        ...(await verifyClaims(
          extra,
          llm,
          evidence,
          budget,
          requestId,
          answerContext,
        )),
      );
    }
  }
  return { verified, end };
}

async function verifyClaims(
  drafts: Draft[],
  llm: AnswerLLM,
  evidence: EvidenceIndex,
  budget: AnswerBudget,
  requestId: string,
  answerContext: AnswerContext,
) {
  const verified: VerifiedDraft[] = [];
  let batchSize = drafts.length;
  for (let offset = 0; offset < drafts.length;) {
    const batch = drafts.slice(offset, offset + batchSize);
    if (budget.signal.aborted) {
      verified.push(...unverifiedDrafts(drafts.slice(offset)));
      break;
    }
    const rows = await verifyDrafts(
      llm,
      batch,
      evidence,
      budget,
      requestId,
      answerContext,
    );
    if (!rows && batch.length > 1) {
      batchSize = Math.floor(batch.length / 2);
      continue;
    }
    verified.push(...(rows ?? unverifiedDrafts(batch)));
    offset += batch.length;
  }
  return verified;
}

function ordered(drafts: Draft[], shape: AnswerShape) {
  return shape === 'timeline'
    ? drafts.sort((a, b) => a.label!.localeCompare(b.label!))
    : drafts;
}

function coarseDate(question: string, statement: string) {
  if (
    !/\b(?:what date|which date|exact (?:date|day)|release date|launch date|when (?:was|were|did)\b.{1,130}\b(?:releas\w*|launch\w*|open\w*|publish\w*))\b/i.test(
      question,
    )
  )
    return false;
  if (/\b(?:what|which) (?:week|month|year)\b/i.test(question)) return false;
  if (
    /\b(?:week|month|year) (?:of|beginning|starting|ending)\b|\b(?:early|mid|late)[ -](?:\p{L}+\s+)?\d{4}\b/iu.test(
      statement,
    )
  )
    return true;
  const month =
    '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const day = new RegExp(
    '\\b(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?[ -]+' +
      month +
      '|' +
      month +
      '[ -]+\\d{1,2}(?:st|nd|rd|th)?(?!\\d))\\b',
    'i',
  );
  return /\b(?:18|19|20)\d{2}\b/.test(statement) && !day.test(statement);
}

function researchFailure(research: ResearchOutput) {
  if (research.status !== 'partial') return;
  switch (research.reason) {
    case 'search_rate_limit':
      return 'The web search provider reached its request limit. Please try again later.';
    case 'search_timeout':
      return 'The web search provider did not respond before the time limit.';
    case 'search_rejected':
      return 'The web search provider rejected the request. Check its configuration.';
    case 'search_unavailable':
      return 'The web search provider is currently unavailable.';
    case 'wall_clock':
    case 'aborted':
      return 'The research time limit expired before I could finish.';
    case 'tokens':
      return 'Research used up the token budget before it could finish.';
    case 'quota':
      return 'The search allowance for this service has been reached.';
  }
}

export function createAnswerer(llm: AnswerLLM) {
  async function* stream(
    input: AnswerInput,
    options: { signal?: AbortSignal; requestId?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    const requestId = options.requestId?.trim() || randomUUID();
    const parsed = AnswerInputSchema.safeParse(input);
    if (!parsed.success) {
      yield {
        type: 'error',
        code: 'invalid_input',
        message: 'The answer input is invalid.',
      };
      yield { type: 'done', requestId };
      return;
    }
    const { plan, research, visibility, message, today } = parsed.data;
    const originalRequest = message ?? plan.standaloneQuery;
    const answerContext = {
      message: originalRequest,
      today: today ?? new Date().toISOString().slice(0, 10),
      questions:
        plan.subQuestions.length > 1 ? plan.subQuestions : [originalRequest],
    };
    const usage = {
      tokensUsed: research.usage.tokensUsed,
      llmCalls: research.usage.llmCalls,
    };
    if (plan.clarifyQuestion && visibility === 'public') {
      const answer = AnswerResultSchema.parse({
        status: 'clarification',
        markdown: escapeMarkdown(plan.clarifyQuestion.replace(/\s+/g, ' ')),
        confidence: 'low',
        conflictingSources: false,
        claims: [],
        usage,
      });
      yield { type: 'token', text: answer.markdown };
      yield { type: 'done', requestId, answer };
      return;
    }
    const passages = plan.comparisonSubjects
      ? balanceComparisonPassages(research.passages, plan.comparisonSubjects)
      : research.passages;
    const received =
      visibility === 'public' &&
      research.status !== 'skipped' &&
      plan.route !== 'no_search'
        ? preparePassages(passages.slice(0, 8), 1000)
        : [];
    const evidence = new Map(received.map((source) => [source.id, source]));
    const { sources, citationIds } = groupPassagesBySource(received);
    const budget = createAnswerBudget(research.usage, options.signal);
    try {
      let result: PipelineResult = {
        verified: [],
        end: { ...unknownEnd, invalid: false },
      };
      if (sources.length) {
        yield {
          type: 'step',
          event: {
            requestId,
            stage: 'answer',
            type: 'synthesis',
            ts: new Date().toISOString(),
            attrs: {},
          },
        };
        yield { type: 'sources', passages: sources };
        const drafts = synthesize(
          llm,
          plan,
          evidence,
          budget,
          requestId,
          answerContext,
        );
        result = await runVerifiedAnswer(
          drafts,
          llm,
          evidence,
          budget,
          requestId,
          answerContext,
          plan.comparisonSubjects
            ? {
                columns: plan.comparisonSubjects.length,
                run: (start, missingColumns, existingAspects) =>
                  synthesize(
                    llm,
                    plan,
                    evidence,
                    budget,
                    requestId,
                    answerContext,
                    {
                      start,
                      missingColumns,
                      existingAspects,
                    },
                  ),
              }
            : undefined,
          (start, questions) =>
            synthesize(
              llm,
              plan,
              evidence,
              budget,
              requestId,
              answerContext,
              undefined,
              { start, questions },
            ),
        );
      }
      const claims = result.verified.map(({ claim }) => ({
        ...claim,
        citedIds: citationIds(claim.citedIds),
      }));
      const verificationIncomplete = claims.some(
        ({ verdict }) => verdict === 'unchecked',
      );
      const supported = ordered(
        result.verified
          .filter(({ claim }) => claim.verdict === 'supported')
          .map(({ draft }) => ({
            ...draft,
            citedIds: citationIds(draft.citedIds),
          })),
        plan.answerShape,
      );
      const conflictingSources = supported.some(
        ({ kind }) => kind === 'conflict',
      );
      const table =
        plan.comparisonSubjects &&
        comparisonTable(supported, plan.comparisonSubjects);
      const missingSubjects =
        plan.comparisonSubjects?.filter(
          (_, index) => !table?.covered.has(index + 1),
        ) ?? [];
      const comparisonGap = missingSubjects.length
        ? 'I couldn’t verify comparison details for ' +
          missingSubjects.join(' and ') +
          '.'
        : table && !table.hasMatchedRow
          ? 'I couldn’t verify matching details for a side-by-side comparison.'
          : table?.hasMissingCells
            ? 'Some table cells could not be verified.'
            : undefined;
      const answeredQuestions = new Set(
        result.verified.flatMap(({ claim, answeredQuestions }) =>
          claim.verdict === 'supported'
            ? (answeredQuestions ?? []).filter((number) => {
                const question = answerContext.questions[number - 1];
                return question && !coarseDate(question, claim.text);
              })
            : [],
        ),
      );
      const coverageKnown = result.verified.some(
        ({ claim, answeredQuestions }) =>
          claim.verdict === 'supported' &&
          (answeredQuestions !== undefined ||
            coarseDate(originalRequest, claim.text)),
      );
      const missingQuestions = answerContext.questions.filter(
        (_, index) => !answeredQuestions.has(index + 1),
      );
      const fullyAnswered = !missingQuestions.length;
      const coverageGap =
        !plan.comparisonSubjects &&
        (answerContext.questions.length > 1 || coverageKnown) &&
        !fullyAnswered
          ? 'Some parts of the question could not be verified.' +
            (message
              ? '\n\nStill to verify:\n' +
                missingQuestions
                  .map(
                    (question) =>
                      '- ' + escapeMarkdown(question.replace(/\s+/g, ' ')),
                  )
                  .join('\n')
              : '')
          : undefined;
      const verificationFailure = result.verified.find(
        ({ failure }) => failure,
      )?.failure;
      const modelFailure = result.end.failure ?? verificationFailure;
      const stopped =
        (modelFailure ? modelFailureMessage(modelFailure) : undefined) ??
        (budget.signal.aborted
          ? 'The answer did not finish before the time limit.'
          : undefined) ??
        researchFailure(research) ??
        (result.end.limited
          ? 'There wasn’t enough answer budget to draft a response.'
          : result.end.invalid && !claims.length
            ? 'The model returned a draft the service could not verify.'
            : undefined);
      const verifiedTitle =
        !sources.length && userFilters(answerContext.message).verifyTitle;
      const missingTitle =
        verifiedTitle &&
        research.status === 'partial' &&
        research.reason === 'insufficient_evidence'
          ? 'I couldn’t find a source confirming the exact title “' +
            verifiedTitle +
            '”.'
          : undefined;
      const interrupted =
        research.status === 'partial' ||
        result.end.invalid ||
        result.end.limited ||
        budget.signal.aborted ||
        result.end.abstained ||
        claims.some(({ verdict }) => verdict !== 'supported');
      const partial =
        Boolean(comparisonGap || coverageGap) ||
        (!fullyAnswered && interrupted);
      const sourceFallback =
        (!supported.length || partial) &&
        (modelFailure ||
          budget.signal.aborted ||
          result.end.limited ||
          verificationIncomplete)
          ? extractSourceEvidence(
              { ...answerContext, questions: missingQuestions },
              sources,
            )
          : undefined;
      const status =
        !supported.length && !sourceFallback
          ? 'abstained'
          : partial || sourceFallback
            ? 'partial'
            : 'complete';
      const domains = new Set(
        supported.flatMap(({ citedIds }) =>
          citedIds.map((id) => evidence.get(id)!.domain),
        ),
      );
      const confidence =
        status !== 'complete'
          ? 'low'
          : conflictingSources || domains.size < 2
            ? 'medium'
            : 'high';
      const checkedMarkdown =
        status === 'abstained'
          ? renderAbstention(
              sources,
              stopped ??
                missingTitle ??
                (verificationIncomplete
                  ? 'I found sources, but couldn’t finish checking the answer. Try again.'
                  : 'I couldn’t verify an answer from the available evidence.'),
            )
          : (comparisonGap
              ? escapeMarkdown(comparisonGap) + '\n\n'
              : coverageGap
                ? coverageGap + '\n\n'
                : '') +
            (table?.markdown ??
              supported
                .map((draft, index) =>
                  renderClaim(draft, plan.answerShape, index),
                )
                .join('')
                .trimEnd());
      const markdown = sourceFallback
        ? (supported.length
            ? checkedMarkdown
            : (stopped ?? 'I couldn’t finish verifying the answer.')) +
          '\n\n' +
          sourceFallback.markdown
        : checkedMarkdown;
      const answer = AnswerResultSchema.parse({
        status,
        markdown,
        confidence,
        conflictingSources,
        claims,
        usage: budget.usage(),
      });

      for (const claim of claims) yield { type: 'verification', claim };
      if (!table && !sourceFallback)
        for (const [index, draft] of supported.entries())
          yield* claimEvents(draft, plan.answerShape, index);
      if ((table && supported.length) || sourceFallback) {
        yield { type: 'token', text: markdown };
        for (const id of new Set([
          ...supported.flatMap(({ citedIds }) => citedIds),
          ...(sourceFallback?.citedIds ?? []),
        ]))
          yield { type: 'citation', id };
      }
      if (status === 'partial') {
        yield {
          type: 'partial',
          reason:
            comparisonGap ??
            coverageGap ??
            stopped ??
            (research.status === 'partial'
              ? research.reason
              : 'Some answer claims could not be verified.'),
        };
      } else if (status === 'abstained') {
        yield {
          type: 'abstain',
          reason:
            stopped ??
            missingTitle ??
            (verificationIncomplete
              ? 'Claim verification did not finish.'
              : 'No supported answer was available.'),
        };
        yield { type: 'token', text: markdown };
        for (const { id } of sources.slice(0, 3))
          yield { type: 'citation', id };
      }
      yield { type: 'done', requestId, answer };
    } finally {
      budget.close();
    }
  }

  return {
    stream,
    async answer(
      input: AnswerInput,
      options?: { signal?: AbortSignal; requestId?: string },
    ): Promise<AnswerResult | undefined> {
      for await (const event of stream(input, options))
        if (event.type === 'done') return event.answer;
    },
  };
}
