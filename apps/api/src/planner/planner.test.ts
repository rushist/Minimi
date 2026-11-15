import type { Plan, SearchSpec } from '@chatagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { createProvider } from '../llm/provider.js';
import {
  LLMFailure,
  type BackendRequest,
  type ModelBackend,
} from '../llm/types.js';
import { llmPolicy } from '../config/llm.js';
import { createPlanner } from './index.js';

const today = '2026-11-12';
const spec = (
  query: string,
  overrides: Partial<SearchSpec> = {},
): SearchSpec => ({
  query,
  exactPhrases: [],
  includeDomains: [],
  excludeDomains: [],
  topic: 'general',
  intent: 'general',
  volatility: 'medium',
  ...overrides,
});
const plan = (query: string, overrides: Partial<Plan> = {}): Plan => ({
  route: 'quick',
  standaloneQuery: query,
  subQuestions: [],
  specs: [spec(query)],
  answerShape: 'short',
  ...overrides,
});
function fake(value: unknown) {
  const complete = vi.fn(async function* (_request: BackendRequest) {
    void _request;
    if (value instanceof LLMFailure) throw value;
    yield {
      type: 'token' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value),
    };
  });
  const backend: ModelBackend = {
    name: 'test',
    models: { small: 'small', strong: 'strong' },
    complete,
  };
  return {
    complete,
    makePlan: createPlanner(
      createProvider([backend], llmPolicy),
      () => new Date(today),
    ),
  };
}
const publicInput = { visibility: 'public' } as const;

describe('planner', () => {
  it('keeps the comparison focus in each search and out of the column names', async () => {
    const message = 'valorant vs cs2 in terms of esports in tabular format';
    const { makePlan } = fake(plan(message));
    const result = await makePlan({
      ...publicInput,
      message,
      webSearch: 'auto',
    });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        comparisonSubjects: ['valorant', 'cs2'],
        specs: [
          { query: 'valorant esports' },
          { query: 'cs2 esports' },
          { query: message },
        ],
      },
    });
  });

  it('starts factual comparisons with a specs search even if the model asks for forums', async () => {
    const message =
      'Compare Model 3 and Model Y in a tablur formaty in separate colunmns';
    const { makePlan } = fake(
      plan(message, {
        specs: [spec('Model 3 vs Model Y Reddit', { intent: 'discussion' })],
      }),
    );
    expect(await makePlan({ ...publicInput, message })).toMatchObject({
      ok: true,
      plan: {
        answerShape: 'comparison',
        specs: [
          {
            query: 'Model 3 official specifications',
            intent: 'primary_source',
            excludeDomains: ['reddit.com', 'quora.com'],
          },
          {
            query: 'Model Y official specifications',
            intent: 'primary_source',
            excludeDomains: ['reddit.com', 'quora.com'],
          },
        ],
      },
    });
  });

  it.each([
    'Search Reddit for opinions about split keyboards',
    'Find opinions on site:reddit.com about split keyboards',
  ])(
    'keeps %s scoped to Reddit even when the model returns a news plan',
    async (message) => {
      const { makePlan } = fake(
        plan(message, {
          specs: [
            spec(message, { intent: 'news', includeDomains: ['bbc.com'] }),
          ],
        }),
      );
      expect(await makePlan({ ...publicInput, message })).toMatchObject({
        ok: true,
        plan: {
          specs: [
            {
              intent: 'discussion',
              topic: 'general',
              includeDomains: ['reddit.com'],
            },
          ],
        },
      });
    },
  );

  it('preserves a named Reddit exclusion', async () => {
    const { makePlan } = fake(
      plan('Split keyboards', {
        specs: [spec('Split keyboards', { intent: 'discussion' })],
      }),
    );
    const result = await makePlan({
      ...publicInput,
      message: 'Find split keyboard opinions, but exclude Reddit',
    });
    expect(result).toMatchObject({
      ok: true,
      plan: { specs: [{ excludeDomains: ['reddit.com'] }] },
    });
    if (result.ok)
      expect(result.plan.specs[0]?.includeDomains).not.toContain('reddit.com');
  });

  it('rewrites a follow-up with one small-model call and bounded conversation context', async () => {
    const { complete, makePlan } = fake(
      plan('How does Node.js handle test timeouts?'),
    );
    const turns = Array.from({ length: 8 }, (_, index) => ({
      role: 'user' as const,
      content: 'Prior turn ' + index,
    }));
    const result = await makePlan({
      ...publicInput,
      message: 'What about timeouts?',
      summary: 'We are discussing the Node.js test runner.',
      turns,
    });
    expect(result).toMatchObject({
      ok: true,
      origin: 'model',
      stats: { calls: 1 },
      plan: {
        route: 'quick',
        standaloneQuery: 'How does Node.js handle test timeouts?',
      },
    });
    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]![0];
    expect(request.model).toBe('small');
    expect(request.messages[0]?.role).toBe('system');
    expect(JSON.parse(request.messages[1]!.content)).toEqual({
      today,
      message: 'What about timeouts?',
      summary: 'We are discussing the Node.js test runner.',
      turns: turns.slice(-6),
    });
  });

  it('uses the focused search query if a single-spec draft repeats the follow-up verbatim', async () => {
    const message =
      'What about setting a timeout? Use only official docs and skip Wikipedia.';
    const query = 'Node.js test runner timeout';
    const { makePlan } = fake(plan(message, { specs: [spec(query)] }));
    expect(
      await makePlan({
        ...publicInput,
        message,
        summary: 'Node.js built-in test runner',
      }),
    ).toMatchObject({
      ok: true,
      origin: 'model',
      plan: {
        standaloneQuery: query,
        specs: [
          { includeDomains: ['nodejs.org'], excludeDomains: ['wikipedia.org'] },
        ],
      },
    });
  });

  it('asks one clarification and discards any proposed searches while waiting', async () => {
    const { makePlan } = fake(
      plan('Mercury', {
        clarifyQuestion: 'Do you mean the planet or the element?',
        assumption: 'The planet',
      }),
    );
    expect(
      await makePlan({ ...publicInput, message: 'Tell me about Mercury.' }),
    ).toMatchObject({
      ok: true,
      origin: 'model',
      plan: {
        route: 'no_search',
        clarifyQuestion: 'Do you mean the planet or the element?',
        specs: [],
      },
    });
  });

  it('preserves an assumption when there is enough context to proceed', async () => {
    const { makePlan } = fake(
      plan('Mercury orbit', { assumption: 'Mercury refers to the planet.' }),
    );
    expect(
      await makePlan({
        ...publicInput,
        message: 'How long does Mercury take to orbit?',
      }),
    ).toMatchObject({
      ok: true,
      plan: { route: 'quick', assumption: 'Mercury refers to the planet.' },
    });
  });

  it('accepts a minimal draft with null optional fields and emits a full SearchSpec', async () => {
    const { makePlan } = fake({
      route: 'quick',
      standaloneQuery: 'Node.js timeouts',
      clarifyQuestion: null,
      specs: [{ query: 'Node.js timeouts', recency: null, dateRange: null }],
    });
    expect(
      await makePlan({
        ...publicInput,
        message: 'Node.js timeouts, only official docs.',
      }),
    ).toMatchObject({
      ok: true,
      origin: 'model',
      plan: {
        specs: [
          {
            query: 'Node.js timeouts',
            intent: 'official_docs',
            topic: 'general',
            volatility: 'medium',
            includeDomains: ['nodejs.org'],
          },
        ],
      },
    });
  });

  it('routes a greeting to no search', async () => {
    const { makePlan } = fake(plan('Hello!', { route: 'no_search' }));
    expect(await makePlan({ ...publicInput, message: 'Hello!' })).toMatchObject(
      {
        ok: true,
        plan: { route: 'no_search', specs: [] },
      },
    );
  });

  it('gives fresh news a fast volatility and resolves the news intent', async () => {
    const query = 'NASA launch updates';
    const { makePlan } = fake(
      plan(query, { specs: [spec(query, { intent: 'news' })] }),
    );
    expect(
      await makePlan({
        ...publicInput,
        message: 'Latest news on NASA launches this week',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            topic: 'news',
            volatility: 'fast',
            includeDomains: ['reuters.com', 'apnews.com', 'bbc.com'],
          },
        ],
      },
    });
  });

  it('applies user constraints even when the model omits them or picks different filters', async () => {
    const query = 'Node.js TLS hostname mismatch';
    const { makePlan } = fake(
      plan(query, {
        specs: [
          spec(query, {
            includeDomains: ['https://fake.invalid', 'example.org'],
            excludeDomains: ['nodejs.org'],
            recency: 'year',
          }),
        ],
      }),
    );
    expect(
      await makePlan({
        ...publicInput,
        message:
          'Find Node.js "ERR_TLS_CERT_ALTNAME_INVALID" last week, only official docs, skip Wikipedia.',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            exactPhrases: ['ERR_TLS_CERT_ALTNAME_INVALID'],
            includeDomains: ['nodejs.org'],
            excludeDomains: ['wikipedia.org'],
            intent: 'official_docs',
            recency: 'week',
            volatility: 'fast',
          },
        ],
      },
    });
  });

  it('honors named site and date filters and caps model search expansions', async () => {
    const { makePlan } = fake(
      plan('Rust methods', {
        route: 'deep',
        specs: ['first', 'second', 'third', 'fourth'].map((query) =>
          spec(query, { includeDomains: ['invalid-url/path'] }),
        ),
      }),
    );
    const result = await makePlan({
      ...publicInput,
      message:
        'Search only official docs from doc.rust-lang.org -site:wikipedia.org between 2026-01-01 and 2026-01-31.',
    });
    expect(result).toMatchObject({ ok: true, origin: 'model' });
    if (!result.ok) throw new Error('Expected plan');
    expect(result.plan.specs).toHaveLength(3);
    for (const query of result.plan.specs)
      expect(query).toMatchObject({
        includeDomains: ['doc.rust-lang.org'],
        excludeDomains: ['wikipedia.org'],
        dateRange: { start: '2026-01-01', end: '2026-01-31' },
      });
  });

  it.each(['not JSON', new LLMFailure('unavailable')])(
    'falls back to one raw search after an invalid or failed model call',
    async (value) => {
      const { complete, makePlan } = fake(value);
      const calls = 1;
      const message = 'Look up Node.js site:nodejs.org -site:wikipedia.org';
      expect(await makePlan({ ...publicInput, message })).toMatchObject({
        ok: true,
        origin: 'fallback',
        stats: { calls },
        plan: {
          route: 'quick',
          standaloneQuery: message,
          specs: [
            {
              query: message,
              includeDomains: ['nodejs.org'],
              excludeDomains: ['wikipedia.org'],
            },
          ],
        },
      });
      expect(complete).toHaveBeenCalledTimes(calls);
    },
  );

  it('uses the alternate provider after the primary is throttled', async () => {
    const primary = vi.fn<ModelBackend['complete']>(() => {
      throw new LLMFailure('rate_limit');
    });
    const secondary = vi.fn(async function* () {
      yield {
        type: 'token' as const,
        text: JSON.stringify(plan('Telescope orbits')),
      };
    });
    const makePlan = createPlanner(
      createProvider(
        [
          {
            name: 'primary',
            models: { small: 'small', strong: 'strong' },
            complete: primary,
          },
          {
            name: 'secondary',
            models: { small: 'small', strong: 'strong' },
            complete: secondary,
          },
        ],
        llmPolicy,
      ),
    );
    expect(
      await makePlan({ ...publicInput, message: 'Telescope orbits' }),
    ).toMatchObject({
      ok: true,
      origin: 'model',
      stats: { calls: 2 },
    });
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
  });

  it('clarifies a missing vehicle before planning or searching', async () => {
    const { complete, makePlan } = fake(
      plan('electric vehicle charging times'),
    );
    expect(
      await makePlan({
        ...publicInput,
        webSearch: 'on',
        message: 'What is its range and how long does it take to charge?',
      }),
    ).toMatchObject({
      ok: true,
      origin: 'local',
      plan: {
        route: 'no_search',
        clarifyQuestion: expect.stringContaining('make, model'),
        specs: [],
      },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps the official publisher and both requested parts', async () => {
    const message =
      'Which terminal does the Heathrow Express stop at for Terminal 5, and do I have to change trains? Cite Heathrow Express.';
    const { makePlan } = fake(
      plan(message, {
        specs: [
          spec('terminal 5 rail service', {
            includeDomains: ['wikipedia.org'],
          }),
        ],
      }),
    );
    expect(await makePlan({ ...publicInput, message })).toMatchObject({
      ok: true,
      plan: {
        specs: [{ includeDomains: ['heathrowexpress.com'] }],
        subQuestions: [
          expect.stringContaining('Which terminal'),
          expect.stringContaining('change trains'),
        ],
      },
    });
  });

  it.each([
    plan('Cecil DeMille film tributes', {
      specs: [
        spec('film industry awards Asia', {
          includeDomains: ['unrelated.example'],
          dateRange: { start: '2024-01-01', end: '2024-12-31' },
        }),
      ],
    }),
    new LLMFailure('rate_limit'),
  ])(
    'anchors an official award lookup to the full name and year',
    async (value) => {
      const { makePlan } = fake(value);
      const result = await makePlan({
        ...publicInput,
        message:
          'Who received the 2024 Cecil B. DeMille Award? If nobody did that year, say so and cite the Golden Globes.',
      });
      expect(result).toMatchObject({
        ok: true,
        plan: {
          specs: [
            {
              query:
                'Cecil B. DeMille Award 2024 recipient honoree presentation ceremony',
              exactPhrases: ['Cecil B. DeMille Award'],
              includeDomains: ['goldenglobes.com'],
              dateRange: undefined,
            },
          ],
        },
      });
    },
  );

  it('retains the prior question when an explicit citation follow-up falls back', async () => {
    const { makePlan } = fake(new LLMFailure('rate_limit'));
    expect(
      await makePlan({
        ...publicInput,
        message: 'Cite the Golden Globes.',
        turns: [
          {
            role: 'user',
            content: 'Who received the 2024 Cecil B. DeMille Award?',
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      origin: 'fallback',
      failure: 'rate_limit',
      plan: {
        specs: [
          {
            query: expect.stringContaining('Cecil B. DeMille Award 2024'),
            includeDomains: ['goldenglobes.com'],
          },
        ],
      },
    });
  });

  it('retains exact title and forecast date in focused searches', async () => {
    const { makePlan } = fake(plan('generic search'));
    expect(
      await makePlan({
        ...publicInput,
        message:
          'Who wrote the fictional 1893 novel The Martian Clockmaker? Verify whether the title exists before naming an author.',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            exactPhrases: ['The Martian Clockmaker'],
            query: expect.stringContaining('The Martian Clockmaker'),
          },
        ],
      },
    });
    expect(
      await makePlan({
        ...publicInput,
        today,
        message: 'Will it rain in Mumbai tomorrow?',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            query: expect.stringContaining('2026-11-13 forecast'),
            volatility: 'fast',
          },
        ],
      },
    });
  });

  it('preserves the publication and reporting periods for an original release', async () => {
    const { makePlan } = fake(plan('BLS employment report'));
    expect(
      await makePlan({
        ...publicInput,
        message:
          'What were the US unemployment rate and change in nonfarm payrolls in the October 2024 release for September 2024? Use the original BLS release.',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            includeDomains: ['bls.gov'],
            query: expect.stringMatching(/October 2024.*September 2024/i),
          },
        ],
      },
    });
  });

  it('repairs a rewritten reporting period and vintage using the original request', async () => {
    const { makePlan } = fake(plan('GDP Q4 2025 second estimate'));
    const result = await makePlan({
      ...publicInput,
      message:
        'What were real US GDP growth and consumer spending in the BEA advance estimate for Q2 2024? Use the original BEA release.',
    });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            includeDomains: ['bea.gov'],
            query: expect.stringContaining(
              'second quarter 2024 advance estimate',
            ),
          },
        ],
      },
    });
    if (result.ok) expect(result.plan.specs[0]?.query).not.toMatch(/Q4|2025/i);
  });

  it('anchors a dated final when asked for a set score and organizer source', async () => {
    const { makePlan } = fake(plan('US Open latest results'));
    expect(
      await makePlan({
        ...publicInput,
        message:
          'Who won the 2024 US Open men’s singles final in tennis, and what was the set score? Cite the tournament.',
      }),
    ).toMatchObject({
      ok: true,
      plan: {
        specs: [
          {
            includeDomains: ['usopen.org', 'usta.com'],
            query: expect.stringMatching(
              /2024 US Open men’s singles final.*match report/i,
            ),
          },
        ],
      },
    });
  });

  it('clarifies an unresolved official-only request instead of broadening it', async () => {
    const { makePlan } = fake(plan('Obscure framework changelog'));
    expect(
      await makePlan({
        ...publicInput,
        message:
          'Find the Obscure framework changelog using only official docs.',
      }),
    ).toMatchObject({
      ok: true,
      origin: 'fallback',
      plan: {
        route: 'no_search',
        clarifyQuestion: expect.any(String),
        specs: [],
      },
    });
  });

  it('keeps private input local and honors cancellation before dispatch', async () => {
    const { complete, makePlan } = fake(plan('unused'));
    expect(await makePlan({ message: 'private context' })).toMatchObject({
      ok: true,
      origin: 'private',
      plan: { route: 'no_search', specs: [] },
      stats: { calls: 0 },
    });
    expect(
      await makePlan(
        { ...publicInput, message: 'public context' },
        { signal: AbortSignal.abort() },
      ),
    ).toEqual({ ok: false, error: 'aborted' });
    expect(complete).not.toHaveBeenCalled();
  });
});
