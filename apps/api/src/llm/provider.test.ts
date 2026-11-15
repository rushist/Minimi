import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProvider } from './provider.js';
import { LLMFailure, type ModelBackend, type LLMRequest } from './types.js';

const request: LLMRequest = {
  purpose: 'planner',
  system: 'Stable instructions',
  context: 'Question',
};
const settings = {
  retries: 1,
  backoffMs: 10,
  maxRetryWaitMs: 100,
  timeoutMs: 100,
  failureThreshold: 2,
  cooldownMs: 1000,
};
const usage = { inputTokens: 10, outputTokens: 5 };

function fake(
  name: string,
  ...responses: (string | LLMFailure)[]
): ModelBackend {
  return {
    name,
    models: { small: name + '-small', strong: name + '-strong' },
    complete: vi.fn(async function* () {
      const response = responses.shift();
      if (response instanceof LLMFailure) throw response;
      if (response === undefined) throw new Error('Unexpected call');
      yield { type: 'token', text: response };
      yield { type: 'usage', usage };
    }),
  };
}

describe('LLM provider', () => {
  it('tries the next provider before retrying a failed planner call', async () => {
    const primary = fake('primary', new LLMFailure('rate_limit'), '{}');
    const fallback = fake('fallback', '{"route":"quick"}');
    const llm = createProvider([primary, fallback], settings);
    const result = await llm.generateStructured(
      { ...request, maxProviderCalls: 2, skipProviderRetries: true },
      z.object({ route: z.literal('quick') }),
    );
    expect(result).toMatchObject({ ok: true, value: { route: 'quick' } });
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).toHaveBeenCalledOnce();
  });

  it('tries the backup when a planner response fails schema validation', async () => {
    const primary = fake('primary', '{"route":"bogus"}');
    const fallback = fake('fallback', '{"route":"quick"}');
    const llm = createProvider([primary, fallback], settings);
    const result = await llm.generateStructured(
      { ...request, maxProviderCalls: 2, skipProviderRetries: true },
      z.object({ route: z.literal('quick') }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { route: 'quick' },
      stats: { calls: 2 },
    });
  });

  it('keeps a different model available after a rate limit and records calls with no generation', async () => {
    const primary = fake(
      'primary',
      new LLMFailure('rate_limit', 5000),
      'draft',
    );
    const fallback = fake('fallback', 'assessment');
    const llm = createProvider([primary, fallback], settings);
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'assessment',
      stats: { calls: 2, usageReports: 1, rateLimitedCalls: 1 },
    });
    expect(
      await llm.generate({ ...request, purpose: 'synthesis' }),
    ).toMatchObject({
      ok: true,
      value: 'draft',
      stats: { calls: 1 },
    });
  });

  it('retries a transient failure with jitter and counts both calls', async () => {
    const primary = fake('primary', new LLMFailure('unavailable'), 'ok');
    const sleep = vi.fn(async () => {});
    const llm = createProvider([primary], settings, {
      sleep,
      random: () => 0.5,
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'ok',
      stats: { calls: 2, ...usage, usageReports: 1 },
    });
    expect(sleep).toHaveBeenCalledWith(7, undefined);
    expect(primary.complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'primary-small' }),
      expect.anything(),
    );
  });

  it('switches providers immediately after a 429 and honors the longer of local and provider cooldowns', async () => {
    const primary = fake(
      'primary',
      new LLMFailure('rate_limit', 40),
      'ok',
      new LLMFailure('rate_limit', 5000),
    );
    const fallback = fake(
      'fallback',
      'backup',
      'strong backup',
      'strong backup',
    );
    const sleep = vi.fn(async () => {});
    let now = 0;
    const llm = createProvider([primary, fallback], settings, {
      sleep,
      now: () => now,
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'backup',
    });
    expect(sleep).not.toHaveBeenCalled();
    now = 1001;
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'ok',
    });
    expect(
      await llm.generate({ ...request, purpose: 'synthesis' }),
    ).toMatchObject({ ok: true, value: 'strong backup', stats: { calls: 2 } });
    now += 1001;
    expect(
      await llm.generate({ ...request, purpose: 'synthesis' }),
    ).toMatchObject({ ok: true, value: 'strong backup', stats: { calls: 1 } });
    expect(primary.complete).toHaveBeenCalledTimes(3);
    expect(fallback.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'fallback-strong' }),
      expect.anything(),
    );
  });

  it('pauses after one headerless 429 and reports skipped cooldown without charging another call', async () => {
    const primary = fake('primary', new LLMFailure('rate_limit'), 'recovered');
    const emit = vi.fn();
    const reserveCall = vi.fn(() => true);
    let now = 0;
    const llm = createProvider([primary], settings, {
      now: () => now,
      tracer: { emit },
      reserveCall,
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: false,
      error: 'rate_limit',
      stats: { calls: 1 },
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: false,
      error: 'rate_limit',
      stats: { calls: 0 },
    });
    expect(reserveCall).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'provider_skipped',
        attrs: expect.objectContaining({
          outcome: 'rate_limit',
          retryAfterMs: 1000,
        }),
      }),
    );
    now = 1001;
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'recovered',
    });
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it('allows one recovery probe after a rate limit and sends concurrent requests to the fallback', async () => {
    const { promise: release, resolve } = Promise.withResolvers<void>();
    let now = 0;
    let fail = true;
    const primary: ModelBackend = {
      name: 'primary',
      models: { small: 'primary-small', strong: 'primary-strong' },
      complete: vi.fn(async function* () {
        if (fail) {
          fail = false;
          throw new LLMFailure('rate_limit');
        }
        await release;
        yield { type: 'token', text: 'recovered' };
      }),
    };
    const fallback = fake('fallback', 'backup', 'concurrent backup');
    const llm = createProvider([primary, fallback], settings, {
      now: () => now,
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'backup',
    });
    now = 1001;
    const probe = llm.generate(request);
    try {
      expect(await llm.generate(request)).toMatchObject({
        ok: true,
        value: 'concurrent backup',
      });
    } finally {
      resolve();
    }
    expect(await probe).toMatchObject({ ok: true, value: 'recovered' });
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it.each(['deep_verification', 'synthesis'] as const)(
    'uses an available small model for %s only after exhausting strong routes',
    async (purpose) => {
      const primary = fake('primary', new LLMFailure('rate_limit'), 'fallback');
      const llm = createProvider([primary], settings);
      expect(
        await llm.generate({
          ...request,
          purpose,
          maxProviderCalls: 2,
          skipProviderRetries: true,
        }),
      ).toMatchObject({ ok: true, value: 'fallback', stats: { calls: 2 } });
      expect(primary.complete).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ model: 'primary-strong' }),
        expect.anything(),
      );
      expect(primary.complete).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: 'primary-small' }),
        expect.anything(),
      );
    },
  );

  it('respects the call cap when every strong route throttles', async () => {
    const primary = fake('primary', new LLMFailure('rate_limit'), 'fallback');
    const secondary = fake('secondary', new LLMFailure('rate_limit'));
    const llm = createProvider([primary, secondary], settings);
    const verification = {
      ...request,
      purpose: 'deep_verification' as const,
      maxProviderCalls: 2,
      skipProviderRetries: true,
    };
    expect(await llm.generate(verification)).toMatchObject({
      ok: false,
      error: 'rate_limit',
      stats: { calls: 2 },
    });
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(secondary.complete).toHaveBeenCalledOnce();
    expect(await llm.generate(verification)).toMatchObject({
      ok: true,
      value: 'fallback',
      stats: { calls: 1 },
    });
  });

  it('opens after failures and allows a recovery probe after cooldown', async () => {
    const primary = fake(
      'primary',
      new LLMFailure('unavailable'),
      new LLMFailure('unavailable'),
      'recovered',
    );
    const fallback = fake('fallback', 'one', 'two');
    let now = 0;
    const llm = createProvider([primary, fallback], settings, {
      now: () => now,
      sleep: async () => {},
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'one',
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'two',
      stats: { calls: 1 },
    });
    now = 1001;
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'recovered',
    });
  });

  it('retries invalid JSON or schema once and then returns a typed failure', async () => {
    const schema = z.object({ value: z.number() });
    const primary = fake(
      'primary',
      'invalid',
      '{"value":2}',
      '{"value":"wrong"}',
      'still invalid',
    );
    const llm = createProvider([primary], settings);
    expect(await llm.generateStructured(request, schema)).toMatchObject({
      ok: true,
      value: { value: 2 },
      stats: { calls: 2 },
    });
    expect(await llm.generateStructured(request, schema)).toMatchObject({
      ok: false,
      error: 'invalid_output',
      stats: { calls: 2 },
    });
    const calls = vi.mocked(primary.complete).mock.calls;
    expect(calls[0]![0].messages[0]).toEqual(calls[1]![0].messages[0]);
  });

  it('does not switch providers after streaming text to the caller', async () => {
    const primary: ModelBackend = {
      name: 'primary',
      models: { small: 'small', strong: 'strong' },
      async *complete() {
        yield { type: 'token', text: 'partial' };
        throw new LLMFailure('unavailable');
      },
    };
    const fallback = fake('fallback', 'backup');
    const events = [];
    for await (const event of createProvider(
      [primary, fallback],
      settings,
    ).stream(request))
      events.push(event);
    expect(events).toMatchObject([
      { type: 'token', text: 'partial' },
      { type: 'error', error: 'unavailable', stats: { calls: 1 } },
    ]);
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('cancels a timed out attempt and uses the fallback', async () => {
    const primary: ModelBackend = {
      name: 'primary',
      models: { small: 'small', strong: 'strong' },
      async *complete(_, signal) {
        yield await new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    };
    const fallback = fake('fallback', 'backup');
    const llm = createProvider([primary, fallback], {
      ...settings,
      retries: 0,
      timeoutMs: 10,
    });
    expect(await llm.generate(request)).toMatchObject({
      ok: true,
      value: 'backup',
      stats: { calls: 2 },
    });
    const aborted = AbortSignal.abort();
    expect(await llm.generate({ ...request, signal: aborted })).toMatchObject({
      ok: false,
      error: 'aborted',
      stats: { calls: 0 },
    });
  });
});
