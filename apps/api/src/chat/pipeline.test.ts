import { describe, expect, it, vi } from 'vitest';
import { createChatPipeline, type ChatJob } from './pipeline.js';
import { createMarketData } from '../market/index.js';

const stats = { inputTokens: 30, outputTokens: 12, calls: 1, usageReports: 1 };
const job: ChatJob = {
  requestId: 'routing-test',
  message: 'What project name is in the file?',
  visibility: 'public',
  webSearch: 'auto',
  history: { summary: '', turns: [] },
  attachments: [{ name: 'notes.txt', text: 'The project is called Willow.' }],
  signal: new AbortController().signal,
};

function fixture(
  route: 'no_search' | 'quick' = 'no_search',
  clarifyQuestion?: string,
  data: Pick<
    Parameters<typeof createChatPipeline>[0],
    'market' | 'weather'
  > = {},
) {
  const plan = vi.fn(async () => ({
    ok: true as const,
    origin: 'model' as const,
    stats,
    plan: {
      route,
      standaloneQuery: job.message,
      subQuestions: [],
      specs: [],
      answerShape: 'short' as const,
      ...(clarifyQuestion ? { clarifyQuestion } : {}),
    },
  }));
  const stream = vi.fn(async function* () {
    yield { type: 'token' as const, text: 'The project ' };
    yield { type: 'token' as const, text: 'is called Willow.' };
    yield { type: 'done' as const, stats };
  });
  const research = vi.fn(async () => ({
    ok: false as const,
    error: 'invalid_input' as const,
  }));
  const run = createChatPipeline({
    ...data,
    plan,
    llm: { stream },
    research,
    answerer: {
      stream: async function* () {
        yield { type: 'done' as const, requestId: job.requestId };
      },
    },
  });
  async function collect(input: ChatJob) {
    const events = [];
    for await (const event of run(input)) events.push(event);
    return events;
  }
  return { plan, research, stream, collect };
}

describe('chat web search controls', () => {
  it('keeps private requests local with web search off', async () => {
    const { plan, research, stream, collect } = fixture();
    const events = await collect({
      ...job,
      visibility: 'private',
      webSearch: 'off',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      answer: { usage: { llmCalls: 0 } },
    });
    expect(plan).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('lets a public request with Web Off use the hosted model without searching', async () => {
    const { plan, research, stream, collect } = fixture();
    const events = await collect({ ...job, webSearch: 'off' });
    expect(plan).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        maxProviderCalls: 2,
        skipProviderRetries: true,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      answer: { status: 'complete' },
    });
  });

  it.each([
    [
      'If I deposit $10,000 at a fixed 4% APY for one year with no fees or withdrawals, what is my ending balance?',
      '$10,400',
    ],
    [
      'Scale a recipe that uses 240 g flour and 180 g water from 4 servings to 7 servings.',
      '420 g flour** and **315 g water',
    ],
    [
      'Explain the difference between mean and median using the numbers 2, 3, 4, 5, 100.',
      'mean is 22.8**',
    ],
  ])(
    'calculates from the supplied inputs, even in Web On: %s',
    async (message, expected) => {
      const { plan, research, stream, collect } = fixture();
      const events = await collect({
        ...job,
        message,
        webSearch: 'on',
        attachments: [],
      });
      expect(plan).not.toHaveBeenCalled();
      expect(research).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        answer: {
          basis: 'calculation',
          markdown: expect.stringContaining(expected),
        },
      });
    },
  );

  it('lets Auto answer from file excerpts without sending them to the planner or searching', async () => {
    const { plan, research, stream, collect } = fixture();
    const events = await collect(job);
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({ hasAttachments: true, webSearch: 'auto' }),
      expect.anything(),
    );
    expect(plan).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachments: expect.anything() }),
      expect.anything(),
    );
    expect(research).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('The project is called Willow.'),
      }),
    );
    expect(events.filter(({ type }) => type === 'token')).toEqual([
      { type: 'token', text: 'The project ' },
      { type: 'token', text: 'is called Willow.' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      answer: { basis: 'attachments', claims: [] },
    });
  });

  it('routes Auto into research when the planner calls for it', async () => {
    const { research, stream, collect } = fixture('quick');
    const events = await collect({ ...job, attachments: [] });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'step',
        event: expect.objectContaining({ stage: 'research' }),
      }),
    );
    expect(research).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
  });

  it('uses live data with timestamps and surfaces stock authentication failures', async () => {
    const market = createMarketData(
      'test-key',
      vi.fn(async (input) => {
        const url = new URL(String(input));
        return url.hostname === 'api.exchange.coinbase.com'
          ? Response.json({ price: '70000.42', time: '2026-11-13T12:00:00Z' })
          : Response.json({ status: 'error', code: 401 }, { status: 401 });
      }),
    );
    const { plan, research, collect } = fixture('quick', undefined, { market });
    const input = { ...job, attachments: [] };
    expect(
      (
        await collect({
          ...input,
          message:
            'What is the latest BTC/USD price? Include the exchange, timestamp and timezone.',
        })
      ).at(-1),
    ).toMatchObject({
      answer: {
        status: 'complete',
        markdown: expect.stringMatching(
          /Coinbase Exchange.*2026-11-13T12:00:00.000Z \(UTC\)/,
        ),
      },
    });
    expect(
      await collect({ ...input, message: 'NVIDIA stock price' }),
    ).toContainEqual({
      type: 'abstain',
      reason: 'market_authentication',
    });
    expect(plan).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
  });

  it('uses an explicit forecast instead of generic research', async () => {
    const forecast = vi.fn(async () => ({
      location: 'Mumbai, India',
      date: '2026-11-14',
      timezone: 'Asia/Kolkata',
      rainMm: 4,
      snowfallCm: 0,
      precipitationProbability: 64,
      temperatureMinC: 21,
      temperatureMaxC: 29,
      sourceUrl: 'https://api.open-meteo.com/v1/forecast',
    }));
    const { plan, research, collect } = fixture('quick', undefined, {
      weather: { forecast },
    });
    const events = await collect({
      ...job,
      attachments: [],
      message:
        'Will it rain in Mumbai tomorrow? Give the forecast date, source, and probability if available.',
    });
    expect(forecast).toHaveBeenCalledWith(
      { location: 'Mumbai', date: 'tomorrow' },
      expect.any(AbortSignal),
    );
    expect(events.at(-1)).toMatchObject({
      answer: {
        status: 'complete',
        markdown: expect.stringMatching(
          /Mumbai, India on 2026-11-14.*64%.*\[S1\]/,
        ),
      },
    });
    expect(plan).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
  });

  it('uses the provided file when the planner asks to see it', async () => {
    const { collect, stream, research } = fixture(
      'no_search',
      'Could you provide the file?',
    );
    const events = await collect(job);
    expect(stream).toHaveBeenCalledOnce();
    expect(research).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      answer: { basis: 'attachments' },
    });
  });
});
