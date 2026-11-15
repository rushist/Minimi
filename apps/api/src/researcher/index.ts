import {
  PassageSchema,
  SearchResultSchema,
  type Passage,
  type SearchResult,
  type SearchSpec,
} from '@chatagent/shared';
import type { Volatility } from '../cache/keys.js';
import {
  balanceComparisonPassages,
  comparisonRequest,
  mentionsSubject,
} from '../answer/comparison.js';
import type { FetchOutcome } from '../fetch/index.js';
import type { LLMProvider } from '../llm/index.js';
import { awardSubject, protectedFilters } from '../planner/index.js';
import {
  requestedScope,
  scopedQuery,
  sourceScopePriority,
} from '../planner/scope.js';
import { userFilters } from '../planner/filters.js';
import type {
  RetrievalInput,
  RetrievalResult,
  Source,
} from '../retrieval/index.js';
import { waitFor } from '../resilience/wait-for.js';
import type { SearchProvider } from '../search/index.js';
import type { SearchError } from '../search/types.js';
import type { QuotaMeter } from '../store/quota.js';
import { canonicalUrl, matchesSourceDomains } from '../url.js';
import { traceSpan } from '../telemetry/scope.js';
import { createGovernor, type ResearchLimits } from './governor.js';
import { relaxSpec } from './relaxation.js';
import { assess, uncovered } from './sufficiency.js';
import {
  ResearchInputSchema,
  ResearchOutputSchema,
  type ResearchInput,
  type ResearchOutput,
  type ResearchReason,
  type ResearchResult,
} from './types.js';

export type { ResearchInput, ResearchOutput, ResearchResult } from './types.js';

interface Dependencies {
  search: SearchProvider;
  fetchPage(
    url: string,
    signal: AbortSignal,
    volatility: Volatility,
    options: { budgeted: true },
  ): Promise<FetchOutcome>;
  retrieve(input: RetrievalInput): Promise<RetrievalResult>;
  llm: Pick<LLMProvider, 'generateStructured'>;
  quota?: Pick<QuotaMeter, 'snapshot'>;
  limits?: ResearchLimits;
  now?: () => Date;
}

interface Candidate {
  result: SearchResult;
  specs: SearchSpec[];
  source?: Source;
}

async function batch<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  signal: AbortSignal,
) {
  const results: (R | undefined)[] = Array.from({ length: items.length });
  if (signal.aborted) return results;
  const tasks = items.map(async (item, index) => {
    try {
      results[index] = await run(item);
    } catch {
      /* Other results remain available. */
    }
  });
  await waitFor(Promise.all(tasks), signal).catch(() => {});
  return results.slice();
}

const queryKey = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();
const specKey = (spec: SearchSpec) => JSON.stringify(spec);
const normalized = (value: string) =>
  (' ' + value.normalize('NFKC').toLowerCase() + ' ').replace(
    /[^\p{L}\p{N}]+/gu,
    ' ',
  );

function matchesTitle(result: SearchResult, title: string) {
  const exact = normalized(title);
  return (
    normalized(result.title).includes(exact) ||
    normalized(result.snippet).includes(exact)
  );
}

const queryWords = new Set([
  'about',
  'according',
  'can',
  'cite',
  'could',
  'did',
  'does',
  'from',
  'give',
  'had',
  'has',
  'have',
  'how',
  'include',
  'into',
  'only',
  'please',
  'show',
  'the',
  'their',
  'them',
  'this',
  'use',
  'using',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'would',
]);

function matchesFocusedQuestion(passage: Passage, question: string) {
  if (passage.text.length < 100 || passage.scores.bm25 <= 0) return false;
  const terms = [...new Set(normalized(question).trim().split(' '))].filter(
    (word) => word.length >= 3 && !queryWords.has(word),
  );
  if (!terms.length) return false;
  const document = normalized(passage.title + ' ' + passage.text);
  const matched = terms.filter((word) => document.includes(' ' + word + ' '));
  return (
    matched.length >=
    Math.min(terms.length, Math.max(2, Math.ceil(terms.length * 0.75)))
  );
}

const searchFailureReasons: Partial<Record<SearchError, ResearchReason>> = {
  rate_limit: 'search_rate_limit',
  timeout: 'search_timeout',
  rejected: 'search_rejected',
  unconfigured: 'search_unavailable',
  unavailable: 'search_unavailable',
  circuit_open: 'search_unavailable',
  invalid_response: 'search_unavailable',
};

function snippets(candidates: Map<string, Candidate>, now: Date) {
  return [...candidates.values()]
    .flatMap(({ result, source }) => {
      if (source) return [source];
      const title = result.title.trim().slice(0, 1000);
      const text = result.snippet.trim().slice(0, 3000);
      return title || text
        ? [
            {
              url: result.url,
              title,
              text: [title, text].filter(Boolean).join('\n\n'),
              retrievedAt: now.toISOString(),
              publishedAt: result.publishedAt,
            },
          ]
        : [];
    })
    .slice(0, 32);
}

function emergencyPassages(sources: Source[], topK: number): Passage[] {
  const passages: Passage[] = [];
  for (const source of sources) {
    const parsed = PassageSchema.safeParse({
      ...source,
      id: 'S' + (passages.length + 1),
      domain: new URL(source.url).hostname.replace(/\.$/, ''),
      text: source.text.slice(0, 1800),
      scores: { bm25: 0, embedding: 0, fused: 0, sourceQuality: 0 },
    });
    if (parsed.success) passages.push(parsed.data);
    if (passages.length === topK) break;
  }
  return passages;
}

export function createResearcher(dependencies: Dependencies) {
  const clock = dependencies.now ?? (() => new Date());
  return async (
    input: ResearchInput,
    options: { signal?: AbortSignal; requestId?: string } = {},
  ): Promise<ResearchResult> => {
    const parsed = ResearchInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_input' };
    const { plan, message, visibility, filterLocks, priorUsage } = parsed.data;
    const governor = createGovernor({
      ...(dependencies.limits ? { limits: dependencies.limits } : {}),
      ...(dependencies.quota ? { quota: dependencies.quota } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(priorUsage ? { priorUsage } : {}),
    });
    const { signal } = governor;
    const scope = requestedScope(message);
    const priority = (title: string, url: string, excerpt?: string) =>
      sourceScopePriority(scope, title, url, excerpt);
    const focus =
      comparisonRequest(message)?.focus ??
      comparisonRequest(plan.standaloneQuery)?.focus;
    const questions = plan.comparisonSubjects
      ? [
          ...plan.comparisonSubjects.map((subject) =>
            focus
              ? 'What facts about ' +
                subject +
                ' are relevant to ' +
                focus +
                '?'
              : 'What facts about ' +
                subject +
                ' directly support the requested comparison?',
          ),
          ...plan.subQuestions,
        ].slice(0, 10)
      : plan.subQuestions.length
        ? plan.subQuestions
        : [plan.standaloneQuery];
    let coverage = uncovered(questions);
    let passages: Passage[] = [];
    const candidates = new Map<string, Candidate>();
    const fetched = new Set<string>();
    const attempted = new Set<string>();
    const attemptedQueries = new Set<string>();
    const relaxedQueries = new Set<string>();
    const thin: SearchSpec[] = [];
    let queue = plan.specs;
    let evidenceVersion = 0;
    let assessedVersion = -1;
    let assessmentFailed = false;
    let readyForVerification = false;
    let quotaBlocked = false;
    let successfulSearch = false;
    const searchErrors = new Set<SearchError>();
    const filters = userFilters(message);
    const titleToVerify =
      filters.verifyTitle ??
      (filters.include.length
        ? (awardSubject(message) ?? awardSubject(plan.standaloneQuery))
        : undefined);
    const subjects = plan.comparisonSubjects;
    const explicit = protectedFilters(message);
    const locks = {
      exact: explicit.exact || !!filterLocks?.exact,
      domains: explicit.domains || !!filterLocks?.domains,
      dates: explicit.dates || !!filterLocks?.dates,
    };

    function finish(
      status: 'complete' | 'partial' | 'skipped',
      reason?: ResearchReason,
    ): ResearchResult {
      const fallback =
        status === 'partial' && !passages.length
          ? emergencyPassages(snippets(candidates, clock()), governor.passages)
          : passages.slice(0, governor.passages);
      const visible = new Set(fallback.map(({ id }) => id));
      const reportedCoverage =
        status === 'skipped'
          ? []
          : coverage.map((row) =>
              row.evidenceIds.every((id) => visible.has(id))
                ? row
                : { ...row, covered: false, evidenceIds: [] },
            );
      const value: ResearchOutput = ResearchOutputSchema.parse({
        status,
        ...(reason ? { reason } : {}),
        degraded: governor.degraded,
        passages: fallback,
        coverage: reportedCoverage,
        usage: governor.usage(),
      });
      return { ok: true, value };
    }

    async function rankAndAssess(volatility: Volatility) {
      if (governor.stopped() || evidenceVersion === assessedVersion) return;
      assessedVersion = evidenceVersion;
      const sources = snippets(candidates, clock());
      if (!sources.length) return;
      try {
        const ranked = await waitFor(
          traceSpan(
            'retrieval',
            () =>
              dependencies.retrieve({
                query: [plan.standaloneQuery, ...plan.subQuestions]
                  .join('\n')
                  .slice(0, 4000),
                sources,
                volatility,
                topK: plan.comparisonSubjects
                  ? governor.passages * 2
                  : governor.passages,
              }),
            { sources: sources.length },
            true,
          ),
          signal,
        );
        if (!ranked.ok || governor.stopped()) return;
        passages = plan.comparisonSubjects
          ? balanceComparisonPassages(
              ranked.value.passages,
              plan.comparisonSubjects,
            ).slice(0, governor.passages)
          : scope.eventYear || scope.period
            ? [...ranked.value.passages].sort(
                (left, right) =>
                  priority(right.title, right.url, right.text) -
                  priority(left.title, left.url, left.text),
              )
            : ranked.value.passages;
        coverage = uncovered(questions);
        if (focusedEvidenceReady()) {
          readyForVerification = true;
          return;
        }
        // Comparison cells will be verified against their own citations.
        // Once every subject has a passage, preserve the model budget for that check.
        if (comparisonEvidenceReady() || assessmentFailed) return;
        governor.updateQuota();
        const check = await traceSpan(
          'sufficiency',
          () =>
            assess(
              dependencies.llm,
              questions,
              passages.slice(0, governor.passages),
              governor,
              options.requestId,
            ),
          { questions: questions.length },
          true,
        );
        coverage = check.coverage;
        assessmentFailed = check.failed;
        quotaBlocked ||= check.quota;
      } catch {
        // Keep the last usable evidence if the ranking stage fails or times out.
      }
    }

    function comparisonEvidenceReady() {
      return Boolean(
        subjects?.every((subject) =>
          passages.some(
            ({ title, text }) =>
              text.length >= 100 &&
              mentionsSubject(title + '\n' + text, subject) &&
              (!focus || mentionsSubject(title + '\n' + text, focus)),
          ),
        ),
      );
    }

    function focusedEvidenceReady() {
      // For a focused question, enough useful context can go straight to final
      // synthesis and claim verification. This check does not verify any fact.
      if (plan.route !== 'quick' || questions.length !== 1 || subjects)
        return false;
      const matches = passages.filter((passage) =>
        matchesFocusedQuestion(passage, questions[0]!),
      );
      return (
        new Set(matches.map(({ domain }) => domain.replace(/^www\./, '')))
          .size >= 2 ||
        matches.some(
          ({ url }) =>
            locks.domains &&
            plan.specs.some(
              ({ includeDomains, excludeDomains }) =>
                includeDomains.length > 0 &&
                matchesSourceDomains(
                  new URL(url),
                  includeDomains,
                  excludeDomains,
                ),
            ),
        )
      );
    }

    function covered() {
      return (
        !governor.stopped() &&
        !governor.blocked('tokens') &&
        coverage.every(
          (row) =>
            row.covered &&
            row.evidenceIds.every((id) =>
              passages
                .slice(0, governor.passages)
                .some((passage) => passage.id === id),
            ),
        )
      );
    }

    try {
      if (visibility === 'private') return finish('skipped', 'private');
      if (plan.route === 'no_search' || plan.clarifyQuestion)
        return finish('skipped', 'no_search');
      governor.updateQuota();

      while (queue.length) {
        governor.updateQuota();
        if (!governor.take('loops')) break;
        if (governor.degraded && subjects && !attempted.size && queue[0]) {
          queue = [
            {
              ...queue[0],
              query: subjects.join(' vs ') + (focus ? ' ' + focus : ''),
              includeDomains: locks.domains
                ? [
                    ...new Set(queue.flatMap((spec) => spec.includeDomains)),
                  ].slice(0, 10)
                : [],
              exactPhrases: locks.exact ? queue[0].exactPhrases : [],
            },
          ];
        }
        const held =
          !attempted.size && subjects?.length === 2 ? queue.slice(2) : [];
        const dispatched: SearchSpec[] = [];
        for (const spec of held.length ? queue.slice(0, 2) : queue) {
          const key = specKey(spec);
          if (attempted.has(key)) continue;
          if (!governor.take('searches')) break;
          attempted.add(key);
          attemptedQueries.add(queryKey(spec.query));
          dispatched.push(spec);
        }
        if (!dispatched.length) break;
        const outcomes = await batch(
          dispatched,
          (spec) =>
            dependencies.search.search(spec, signal, {
              reserveCredits: governor.reserveCredits,
            }),
          signal,
        );
        for (const [index, outcome] of outcomes.entries()) {
          if (!outcome?.ok) {
            if (outcome) searchErrors.add(outcome.error);
            continue;
          }
          successfulSearch = true;
          const searchSpec = dispatched[index]!;
          const rows = outcome.results.slice(0, 16).flatMap((result) => {
            const checked = SearchResultSchema.safeParse(result);
            const url = checked.success
              ? canonicalUrl(checked.data.url)
              : undefined;
            return url &&
              checked.success &&
              (!titleToVerify || matchesTitle(checked.data, titleToVerify)) &&
              priority(checked.data.title, url.href, checked.data.snippet) >=
                0 &&
              matchesSourceDomains(
                url,
                searchSpec.includeDomains,
                searchSpec.excludeDomains,
              )
              ? [{ ...checked.data, url: url.href }]
              : [];
          });
          if (
            rows.length < 2 ||
            !rows.some(({ snippet }) => snippet.trim().length >= 40)
          )
            thin.push(dispatched[index]!);
          for (const result of rows) {
            const previous = candidates.get(result.url);
            if (previous) previous.specs.push(searchSpec);
            if (
              !previous ||
              (!previous.source &&
                result.snippet &&
                (!previous.result.snippet ||
                  (result.provider === 'tavily' &&
                    previous.result.provider !== 'tavily')))
            ) {
              candidates.set(result.url, {
                result,
                specs: previous?.specs ?? [searchSpec],
              });
              evidenceVersion++;
            }
          }
        }
        const volatility = dispatched.some((spec) => spec.volatility === 'fast')
          ? 'fast'
          : dispatched.some((spec) => spec.volatility === 'medium')
            ? 'medium'
            : 'slow';
        await rankAndAssess(volatility);
        if (readyForVerification || covered() || comparisonEvidenceReady())
          return finish('complete');
        if (governor.stopped() || governor.blocked('tokens')) break;

        governor.updateQuota();
        const preferred = new Set(passages.map(({ url }) => url));
        const urls = [...candidates.keys()]
          .filter((url) => !fetched.has(url))
          .sort(
            (a, b) =>
              Number(preferred.has(b)) - Number(preferred.has(a)) ||
              candidates.get(a)!.result.rank - candidates.get(b)!.result.rank,
          );
        const reads: string[] = [];
        for (const url of urls.slice(0, 3)) {
          if (!governor.take('pages')) break;
          fetched.add(url);
          reads.push(url);
        }
        const pages = await batch(
          reads,
          (url) =>
            dependencies.fetchPage(url, signal, volatility, { budgeted: true }),
          signal,
        );
        for (const [index, page] of pages.entries()) {
          if (!page?.ok) continue;
          const entry = candidates.get(reads[index]!)!;
          const finalUrl = canonicalUrl(page.page.url);
          const title = page.page.title || entry.result.title.slice(0, 1000);
          if (
            !finalUrl ||
            priority(title, finalUrl.href, page.page.text) < 0 ||
            !entry.specs.some((spec) =>
              matchesSourceDomains(
                finalUrl,
                spec.includeDomains,
                spec.excludeDomains,
              ),
            )
          )
            continue;
          const snippet =
            finalUrl.href === entry.result.url
              ? entry.result.snippet.trim().slice(0, 1000)
              : '';
          entry.source = {
            url: finalUrl.href,
            title,
            text: (snippet
              ? snippet + '\n\n' + page.page.text
              : page.page.text
            ).slice(0, 100_000),
            retrievedAt: page.page.retrievedAt,
            publishedAt: entry.result.publishedAt,
          };
          evidenceVersion++;
        }
        await rankAndAssess(volatility);
        if (readyForVerification || covered() || comparisonEvidenceReady())
          return finish('complete');
        if (quotaBlocked && passages.length) break;
        if (governor.stopped() || governor.blocked('tokens')) break;

        queue = [];
        if (subjects) {
          for (const [index, subject] of subjects.entries()) {
            if (coverage[index]?.covered) continue;
            const base = plan.specs[index] ?? plan.specs[0];
            if (!base) continue;
            const query = [subject, focus, 'official sources']
              .filter(Boolean)
              .join(' ');
            if (!attemptedQueries.has(queryKey(query)))
              queue.push({ ...base, query });
          }
        }
        queue.push(...held);
        for (const spec of thin) {
          const key = queryKey(spec.query);
          if (relaxedQueries.has(key)) continue;
          const relaxed = relaxSpec(spec, locks);
          if (!relaxed || attempted.has(specKey(relaxed))) continue;
          relaxedQueries.add(key);
          queue.push(relaxed);
        }
        const base = plan.specs[0];
        if (base) {
          for (const row of coverage) {
            const query = scopedQuery(row.question, message, scope);
            const key = queryKey(query);
            if (!row.covered && !attemptedQueries.has(key))
              queue.push({ ...base, query });
          }
        }
      }

      return finish(
        'partial',
        (signal.aborted ? governor.reason() : undefined) ??
          (successfulSearch
            ? undefined
            : Object.entries(searchFailureReasons).find(([error]) =>
                searchErrors.has(error as SearchError),
              )?.[1]) ??
          governor.reason() ??
          (quotaBlocked || searchErrors.has('quota_exhausted')
            ? 'quota'
            : assessmentFailed
              ? 'sufficiency_unavailable'
              : 'insufficient_evidence'),
      );
    } finally {
      governor.close();
    }
  };
}

export { ResearchOutputSchema } from './types.js';
