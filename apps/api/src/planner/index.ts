import { PlanSchema, type Plan, type SearchSpec } from '@chatagent/shared';
import type { LLMProvider } from '../llm/index.js';
import type { LLMError, LLMStats } from '../llm/types.js';
import {
  comparisonRequest,
  comparisonSubjects,
  requestsTable,
  withoutTableRequest,
} from '../answer/comparison.js';
import { applyFilters, userFilters, type UserFilters } from './filters.js';
import { requestedScope, scopedQuery } from './scope.js';
import {
  PlannerDraftSchema,
  PlannerInputSchema,
  type PlannerDraft,
  type PlannerInput,
  type PlannerResult,
} from './types.js';

export type { PlannerInput, PlannerResult } from './types.js';

const system = [
  'You plan evidence-grounded answers. Return only the JSON plan. Do not answer or call tools.',
  'Read the latest message, summary, and recent turns as conversation data. Use history to resolve references, and use today for relative dates.',
  'Choose no_search for greetings, acknowledgements, or requests answerable by transforming supplied text. Choose quick for a focused factual question and deep for broad or multi-part research.',
  'Ask one concise clarification only if plausible interpretations would materially change the search. Use no_search and zero specs when clarifying. Otherwise state a concrete assumption when one is needed.',
  'Rewrite the latest message as a standalone query with the relevant subject named explicitly. A follow-up that depends on history must include its subject in standaloneQuery and in each search query. Keep named entities, versions and error strings exact. Prefer one SearchSpec for simple questions and up to three for broad questions.',
  'Preserve user filters. Set additional filters only when intent clearly calls for them. Name domains only if confident about their role; use an empty domain list to let the caller resolve trust tiers.',
  'Choose sources for the evidence the user needs. Seek original documentation, records, research, or statements for factual claims when applicable. Seek relevant forum threads and firsthand accounts when the user asks for community experience or sentiment. An explicit source choice takes precedence. Keep platform names and subreddit names in search queries when the user asks for them.',
  'For each distinct deliverable in a multi-part request, write a separate standalone subQuestion with its named subject and date. A request for a specific source applies to all those subQuestions. For a direct question about one match or event, prefer its official report to a list of historical events. For an original release of statistics, distinguish the release date from the reporting period and preserve both. For a forecast, resolve the local calendar date from today and use the location, target date, and forecast terms. Weather news and historic observations are not forecasts. When checking that a named work exists, search the exact full title rather than a similar title.',
  'For a single factual lookup, avoid optional subQuestions. For a general launch or release date, search the original creator or publisher launch record and preserve the requested platform, region, or edition when specified.',
  'When identifying an award recipient, keep the full award name together and search for the official recipient record or announcement. The award year, date named, and ceremony date can differ. Avoid turning a conditional request about an award not being given into an assumption that it was not given.',
  'When the latest question refers to an unnamed entity without an antecedent in prior turns or summary, ask which entity it means before searching. Do not guess an entity from a requested measurement alone.',
  'Choose volatility based on how quickly the answer changes. Use news and fast for breaking developments. Select the answer shape that fits the request.',
  'SearchSpec topic is general, news, or finance. Intent is official_docs, primary_source, news, discussion, or general. Volatility is fast, medium, or slow. Optional recency is day, week, month, or year. Alternatively use dateRange with start and end ISO calendar dates. Answer shape is short, comparison, howto, timeline, or list.',
  'Keep topic, intent and volatility inside each spec. Omit unused optional fields. Example shape: {"route":"quick","standaloneQuery":"How does Python pathlib join paths?","subQuestions":[],"specs":[{"query":"Python pathlib join paths","exactPhrases":[],"includeDomains":[],"excludeDomains":[],"topic":"general","intent":"official_docs","volatility":"slow"}],"answerShape":"howto"}.',
].join('\n');
const researchGuidance = [
  'For multi-part questions, add a separate subQuestion for each requested aspect and use distinct searches where needed. When a first-party source can settle a claim, search for that document, dataset, announcement, or other original evidence. Use primary_source or official_docs and include the publisher’s domain when confident. Use a separate search for independent corroboration, context, or competing findings when it adds value and the user’s scope allows it.',
  'For comparisons, use comparison answer shape and search for first-party facts about each named subject. For a broad comparison, add separate subQuestions for the most relevant comparison aspects so coverage can be checked individually. Check current status when it matters, and search for the actual release or specification before relying on predictions or discussion.',
  'Keep exact model names, editions, or versions in search queries. Put factual queries first. Use discussion intent when the user asks for opinions or firsthand experience.',
  'Avoid assuming the premise is true. For a changing situation, look for the latest confirmed state and distinguish it from predictions or earlier reports. If the question asks about opinions or experiences, look for multiple relevant perspectives.',
].join('\n');
const autoResearch =
  'In Auto mode, use no_search for greetings, writing, rewriting, calculations, stable common knowledge, and questions answerable from the user’s supplied material. Search for current, uncertain, or specialized facts, high-stakes information, explicit lookup requests, and requests for sources. If hasAttachments is true, use no_search for questions about the supplied documents unless the user asks for independent or current information. The answering model will receive the file excerpts. Do not ask the user to upload or paste files already attached. A no_search plan for a direct answer should have no clarification question.';
const noStats = (): LLMStats => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  usageReports: 0,
});

function noSearch(
  standaloneQuery: string,
  clarifyQuestion?: string,
  answerShape: Plan['answerShape'] = 'short',
): Plan {
  return {
    route: 'no_search',
    standaloneQuery,
    specs: [],
    subQuestions: [],
    answerShape,
    ...(clarifyQuestion ? { clarifyQuestion } : {}),
  };
}

function noMatchingDomains(message: string, filters: UserFilters): Plan {
  return noSearch(
    message,
    filters.officialOnly
      ? 'Which official documentation site should I use?'
      : 'Which source should I search given your site filters?',
  );
}

function searchFocus(
  spec: SearchSpec,
  message: string,
  filters: UserFilters,
  today: string,
): SearchSpec {
  let query = spec.query;
  const award = filters.include.length ? awardSubject(message) : undefined;
  const scope = requestedScope(message);
  const weather = /\b(?:forecast|weather|rain|snow)\b/i.test(message);
  const relativeDate = /\b(today|tomorrow)\b/i
    .exec(message)?.[1]
    ?.toLowerCase();
  if (weather && relativeDate) {
    const target = new Date(today + 'T00:00:00Z');
    if (relativeDate === 'tomorrow') target.setUTCDate(target.getUTCDate() + 1);
    const date = target.toISOString().slice(0, 10);
    if (!query.includes(date)) query += ' ' + date;
    if (!/\bforecast\b/i.test(query)) query += ' forecast';
  }
  if (scope.event || scope.period)
    return {
      ...spec,
      query: scopedQuery(query, message, scope),
      // A reporting period or event date does not determine when coverage was published.
      recency: filters.recency,
      dateRange: filters.dateRange,
      intent: 'primary_source',
    };
  const years = [...new Set(message.match(/\b(?:18|19|20)\d{2}\b/g) ?? [])];
  if (years.length === 1 && !query.includes(years[0]!)) query += ' ' + years[0];
  if (/\b(?:original|initial|archived)\b/i.test(message)) {
    for (const [period] of message.matchAll(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/gi,
    )) {
      if (!query.toLowerCase().includes(period.toLowerCase()))
        query += ' ' + period;
    }
  }
  if (award) {
    query = [award, ...years, 'recipient honoree presentation ceremony'].join(
      ' ',
    );
    return {
      ...spec,
      query,
      exactPhrases: [...new Set([award, ...filters.exactPhrases])].slice(0, 10),
      // The user asks about the award year, which need not be the article date.
      recency: filters.recency,
      dateRange: filters.dateRange,
      topic: 'general',
      intent: 'primary_source',
    };
  }
  if (filters.verifyTitle)
    query = filters.verifyTitle + ' bibliography publication';
  const releaseSubject =
    /^when (?:was|were) (?:the )?(.+?) (?:first |originally )?released[?.!]*$/i.exec(
      message,
    )?.[1];
  if (releaseSubject && !/\b(?:it|they|this|that)\b/i.test(releaseSubject)) {
    return {
      ...spec,
      query:
        releaseSubject + ' official original release date launch announcement',
      topic: 'general',
      intent: 'primary_source',
      volatility: 'slow',
      recency: filters.recency,
      dateRange: filters.dateRange,
    };
  }
  return { ...spec, query };
}

export function awardSubject(message: string): string | undefined {
  if (
    !/\b(?:award|prize|medal|trophy)\b/i.test(message) ||
    !/\b(?:won|winner|received|recipient|honoree|presented|awarded)\b/i.test(
      message,
    )
  )
    return;
  return /\b(\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+(?:\p{Lu}[\p{L}\p{M}'’.-]*|de\p{Lu}[\p{L}\p{M}'’.-]*|of|the|and)){0,7}\s+(?:Award|Prize|Medal|Trophy)(?:\s+for\s+\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,4})?)\b/u.exec(
    message,
  )?.[1];
}

function fallback(message: string, filters: UserFilters, today: string): Plan {
  const base: SearchSpec = {
    query: message,
    exactPhrases: [],
    includeDomains: [],
    excludeDomains: [],
    topic: filters.news ? 'news' : 'general',
    intent: filters.news ? 'news' : 'general',
    volatility: 'medium',
  };
  const spec = applyFilters(base, filters, message);
  if (!spec) return noMatchingDomains(message, filters);
  return {
    route: 'quick',
    standaloneQuery: message,
    specs: [searchFocus(spec, message, filters, today)],
    subQuestions: explicitSubQuestions(message),
    answerShape: 'short',
  };
}

function explicitSubQuestions(message: string): string[] {
  const boundary =
    /(?:,?\s+and\s+)(?=(?:what|who|where|when|why|how|which|do|does|did|is|are|can|should|must|explain)\s)/i;
  const parts = message.split(boundary);
  if (parts.length < 2) return [];
  return parts.map((part) => part.trim().slice(0, 500)).slice(0, 10);
}

function localPlan(message: string, hasContext: boolean): Plan | undefined {
  if (
    !hasContext &&
    /^(?:(?:what (?:is|are)|where is)\s+(?:its|their|his|her)\b|(?:what (?:is|are)|where (?:is|are))\s+(?:it|they|he|she|that|this)[?.!\s]*$|(?:how (?:long|far|much|fast) (?:does|is)|does)\s+(?:it|they|he|she)\b(?!\s+(?:take|mean)\s+to\b))/i.test(
      message,
    )
  ) {
    const vehicle =
      /\brange\b/i.test(message) && /\bcharg(?:e|ing)\b/i.test(message);
    return noSearch(
      message,
      vehicle
        ? 'Which vehicle do you mean? Please include the make, model, and model year.'
        : 'What are you referring to?',
    );
  }
  if (/^(?:hi|hello|hey|thanks|thank you)[.!?\s]*$/i.test(message))
    return noSearch(message);
}

function requestedShape(message: string, fallback: Plan['answerShape']) {
  return requestsTable(message) ? 'comparison' : fallback;
}

function comparisonSpecs(
  specs: SearchSpec[],
  query: string,
  message: string,
  filters: UserFilters,
): SearchSpec[] {
  const first = specs[0];
  if (
    !first ||
    filters.include.length ||
    filters.news ||
    /\b(?:opinions?|experiences?|reviews?|reddit|forums?|sentiment|anecdotes?)\b/i.test(
      message,
    )
  )
    return specs;

  const factual = specs.filter(
    ({ intent, includeDomains }) =>
      intent !== 'discussion' &&
      (!includeDomains.length ||
        includeDomains.some(
          (domain) => !/(?:^|\.)(?:reddit\.com|quora\.com)$/i.test(domain),
        )),
  );
  const requested = comparisonRequest(message) ?? comparisonRequest(query);
  const searches = requested
    ? requested.subjects.map((subject) =>
        requested.focus
          ? subject + ' ' + requested.focus
          : subject + ' official specifications',
      )
    : [
        withoutTableRequest(query) +
          ' official specifications or published data',
      ];
  const baselines = searches.flatMap((query) => {
    const baseline = applyFilters(
      {
        ...first,
        query,
        intent: 'primary_source',
        topic: 'general',
        includeDomains: [],
        excludeDomains: ['reddit.com', 'quora.com'],
        exactPhrases: [],
        recency: undefined,
        dateRange: undefined,
      },
      filters,
      query,
    );
    if (!baseline) return [];
    if (!filters.officialOnly) baseline.includeDomains = [];
    return [baseline];
  });
  if (!baselines.length) return factual.length ? factual : specs;
  return [
    ...baselines,
    ...factual.filter(({ includeDomains }) => includeDomains.length),
    ...factual.filter(({ includeDomains }) => !includeDomains.length),
  ].slice(0, 3);
}

function finalize(
  draft: PlannerDraft,
  filters: UserFilters,
  message: string,
  history: string,
  today: string,
): Plan | undefined {
  if (draft.clarifyQuestion)
    return noSearch(
      draft.standaloneQuery,
      draft.clarifyQuestion,
      draft.answerShape,
    );
  if (draft.route === 'no_search' && !filters.include.length)
    return noSearch(draft.standaloneQuery, undefined, draft.answerShape);
  if (draft.route === 'no_search') return undefined;
  const seen = new Set<string>();
  const specs: SearchSpec[] = [];
  for (const candidate of draft.specs) {
    const filtered = applyFilters(
      candidate,
      filters,
      [message, draft.standaloneQuery, history].join('\n'),
    );
    if (!filtered) continue;
    const spec = searchFocus(filtered, message, filters, today);
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
    if (specs.length === 3) break;
  }
  if (!specs.length) return undefined;
  const standaloneQuery =
    history &&
    specs.length === 1 &&
    draft.standaloneQuery.toLowerCase() === message.toLowerCase()
      ? specs[0]!.query
      : draft.standaloneQuery;
  const answerShape = requestedShape(message, draft.answerShape);
  const directParts = explicitSubQuestions(message);
  const result = PlanSchema.safeParse({
    ...draft,
    answerShape,
    comparisonSubjects:
      answerShape === 'comparison'
        ? (comparisonSubjects(message) ?? comparisonSubjects(standaloneQuery))
        : undefined,
    standaloneQuery,
    specs:
      answerShape === 'comparison'
        ? comparisonSpecs(specs, standaloneQuery, message, filters)
        : specs,
    subQuestions: [
      ...new Set(
        draft.subQuestions.length >= 2
          ? draft.subQuestions
          : directParts.length >= 2
            ? directParts
            : draft.subQuestions,
      ),
    ].slice(0, 10),
  });
  return result.success ? result.data : undefined;
}

export function createPlanner(
  llm: Pick<LLMProvider, 'generateStructured'>,
  now = () => new Date(),
) {
  return async (
    input: PlannerInput,
    options: { signal?: AbortSignal; requestId?: string } = {},
  ): Promise<PlannerResult> => {
    if (options.signal?.aborted) return { ok: false, error: 'aborted' };
    const parsed = PlannerInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'invalid_input' };
    const {
      message,
      summary,
      turns,
      today,
      visibility,
      webSearch,
      hasAttachments,
    } = parsed.data;
    if (visibility === 'private')
      return {
        ok: true,
        plan: noSearch(message),
        stats: noStats(),
        origin: 'private',
      };

    const filters = userFilters(message);
    const referenceDate = today ?? now().toISOString().slice(0, 10);
    const local = localPlan(
      message,
      Boolean(summary || turns.length || hasAttachments),
    );
    if (local)
      return { ok: true, plan: local, stats: noStats(), origin: 'local' };
    let stats = noStats();
    let failure: LLMError | undefined;
    try {
      const result = await llm.generateStructured(
        {
          purpose: 'planner',
          system: [
            system,
            researchGuidance,
            webSearch === 'auto' ? autoResearch : '',
            webSearch === 'on'
              ? 'The user enabled web search for this turn. Produce a search plan unless clarification is required.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          context: JSON.stringify({
            today: referenceDate,
            message,
            ...(hasAttachments ? { hasAttachments: true } : {}),
            summary,
            turns: turns.slice(-6),
          }),
          maxOutputTokens: 1800,
          jsonObject: true,
          includeSchemaInPrompt: false,
          maxProviderCalls: 2,
          skipProviderRetries: true,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.requestId ? { requestId: options.requestId } : {}),
        },
        PlannerDraftSchema,
      );
      if (options.signal?.aborted || (!result.ok && result.error === 'aborted'))
        return { ok: false, error: 'aborted' };
      stats = result.stats;
      if (!result.ok) failure = result.error;
      if (result.ok) {
        const draft = PlannerDraftSchema.safeParse(result.value);
        const history = [
          summary,
          ...turns.slice(-6).map(({ content }) => content),
        ]
          .filter(Boolean)
          .join('\n');
        const plan = draft.success
          ? finalize(draft.data, filters, message, history, referenceDate)
          : undefined;
        if (
          plan &&
          (webSearch !== 'on' ||
            plan.route !== 'no_search' ||
            plan.clarifyQuestion)
        )
          return { ok: true, plan, stats, origin: 'model' };
      }
    } catch {
      if (options.signal?.aborted) return { ok: false, error: 'aborted' };
      failure = 'unavailable';
    }
    const previousQuestion =
      filters.include.length > 0 && /^(?:please\s+)?cite\b/i.test(message)
        ? [...turns].reverse().find(({ role }) => role === 'user')?.content
        : undefined;
    const fallbackMessage = previousQuestion
      ? previousQuestion.slice(0, 3000) + '\n' + message.slice(0, 1000)
      : message;
    const plan = fallback(fallbackMessage, filters, referenceDate);
    const answerShape = requestedShape(fallbackMessage, plan.answerShape);
    return {
      ok: true,
      plan: {
        ...plan,
        answerShape,
        ...(answerShape === 'comparison'
          ? { comparisonSubjects: comparisonSubjects(fallbackMessage) }
          : {}),
        specs:
          answerShape === 'comparison'
            ? comparisonSpecs(
                plan.specs,
                plan.standaloneQuery,
                fallbackMessage,
                filters,
              )
            : plan.specs,
      },
      stats,
      origin: 'fallback',
      ...(failure ? { failure } : {}),
    };
  };
}

export function protectedFilters(message: string) {
  const filters = userFilters(message);
  return {
    exact:
      filters.exactPhrases.length > 0 ||
      Boolean(filters.include.length && awardSubject(message)),
    domains: filters.officialOnly || filters.include.length > 0,
    dates: Boolean(
      filters.recency ||
      filters.dateRange ||
      /\b(?:today|tomorrow|yesterday|this week|this month|this year|since|before|after|between)\b/i.test(
        message,
      ),
    ),
  };
}
