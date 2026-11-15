import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Tracer } from '../telemetry/tracer.js';
import { captureArtifact, capturingArtifacts } from '../telemetry/scope.js';
import { createBreaker } from '../resilience/breaker.js';
import { assemblePrompt, modelTier } from './prompt.js';
import {
  LLMFailure,
  type LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type LLMStats,
  type LLMStreamEvent,
  type ModelBackend,
} from './types.js';

export interface LLMPolicy {
  retries: number;
  backoffMs: number;
  maxRetryWaitMs: number;
  timeoutMs: number;
  failureThreshold: number;
  cooldownMs: number;
}

interface ProviderOptions {
  reserveCall?: (provider: string) => boolean;
  tracer?: Tracer;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const emptyStats = (): LLMStats => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  usageReports: 0,
});
const transient = (code: LLMError) =>
  code === 'timeout' || code === 'unavailable' || code === 'rate_limit';

const invalidJson = Symbol();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalidJson;
  }
}

export function createProvider(
  backends: readonly ModelBackend[],
  policy: LLMPolicy,
  options: ProviderOptions = {},
): LLMProvider {
  const {
    now = Date.now,
    random = Math.random,
    tracer,
    sleep = (ms, signal) => delay(ms, undefined, { signal }),
  } = options;
  const chain = backends.map((backend) => ({
    backend,
    models: new Map(
      [...new Set(Object.values(backend.models))].map((model) => [
        model,
        {
          breaker: createBreaker(
            policy.failureThreshold,
            policy.cooldownMs,
            now,
          ),
          rateLimitedUntil: 0,
        },
      ]),
    ),
  }));

  async function* execute(
    request: LLMRequest,
    stream: boolean,
    stats: LLMStats,
    contextSuffix?: string,
    validate?: (text: string) => Promise<boolean>,
  ): AsyncGenerator<LLMStreamEvent> {
    const requestId = request.requestId ?? randomUUID();
    const messages = assemblePrompt(request, contextSuffix);
    let error: LLMError = chain.length ? 'circuit_open' : 'unconfigured';
    let skippedRateLimit = false;
    const tier = modelTier(request.purpose);
    const candidates = chain.map((route, index) => ({
      ...route,
      model: route.backend.models[tier],
      fallback: index !== 0,
      downgraded: false,
    }));
    if (
      request.purpose === 'deep_verification' ||
      request.purpose === 'synthesis'
    ) {
      candidates.push(
        ...chain
          .filter(
            ({ backend }) => backend.models.small !== backend.models.strong,
          )
          .map((route) => ({
            ...route,
            model: route.backend.models.small,
            fallback: true,
            downgraded: true,
          })),
      );
    }
    const maxCalls = request.maxProviderCalls ?? Infinity;

    for (const { backend, models, model, fallback, downgraded } of candidates) {
      if (stats.calls >= maxCalls || request.signal?.aborted) break;
      if (downgraded && !transient(error) && error !== 'circuit_open') break;
      const state = models.get(model)!;
      const cooldown = state.rateLimitedUntil - now();
      if (cooldown > 0) {
        skippedRateLimit = true;
        tracer?.emit({
          requestId,
          stage: 'llm',
          type: 'provider_skipped',
          ts: new Date().toISOString(),
          attrs: {
            provider: backend.name,
            model,
            fallback,
            outcome: 'rate_limit',
            retryAfterMs: cooldown,
          },
        });
        continue;
      }
      for (
        let retry = 0;
        retry <= policy.retries &&
        stats.calls < maxCalls &&
        !request.signal?.aborted;
        retry++
      ) {
        const finish = state.breaker.enter();
        if (!finish) {
          tracer?.emit({
            requestId,
            stage: 'llm',
            type: 'provider_skipped',
            ts: new Date().toISOString(),
            attrs: {
              provider: backend.name,
              model,
              fallback,
              outcome: 'circuit_open',
            },
          });
          break;
        }

        try {
          if (options.reserveCall && !options.reserveCall(backend.name)) {
            finish('neutral');
            error = 'quota_exhausted';
            break;
          }
        } catch {
          finish('neutral');
          error = 'quota_unavailable';
          break;
        }
        const started = now();
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(),
          request.timeoutMs ?? policy.timeoutMs,
        );
        const signal = request.signal
          ? AbortSignal.any([timeout.signal, request.signal])
          : timeout.signal;
        let outcome: 'success' | 'failure' | 'neutral' = 'neutral';
        let failure: LLMFailure | undefined;
        let sent = false;
        let text = '';
        const capture = capturingArtifacts();
        let captured = '';
        let usage;
        stats.calls++;
        try {
          const input = {
            model,
            messages,
            stream,
            ...(request.jsonObject ? { jsonObject: true } : {}),
            ...(request.reasoningEffort
              ? { reasoningEffort: request.reasoningEffort }
              : {}),
            ...(request.maxOutputTokens !== undefined
              ? { maxOutputTokens: request.maxOutputTokens }
              : {}),
          };
          for await (const event of backend.complete(input, signal)) {
            signal.throwIfAborted();
            if (event.type === 'usage') {
              usage = event.usage;
            } else if (event.text) {
              sent = true;
              if (capture && captured.length <= 64_000)
                captured += event.text.slice(0, 64_001 - captured.length);
              if (stream) yield event;
              else text += event.text;
            }
          }
          signal.throwIfAborted();
          if (!sent) throw new LLMFailure('invalid_output');
          if (validate && !(await validate(text)))
            throw new LLMFailure('invalid_output');
          outcome = 'success';
        } catch (cause) {
          if (request.signal?.aborted) failure = new LLMFailure('aborted');
          else if (timeout.signal.aborted) failure = new LLMFailure('timeout');
          else
            failure =
              cause instanceof LLMFailure
                ? cause
                : new LLMFailure('unavailable');
          if (transient(failure.code)) outcome = 'failure';
        } finally {
          clearTimeout(timer);
          timeout.abort();
          const retryAfterMs = failure?.retryAfterMs;
          if (failure?.code === 'rate_limit') {
            state.rateLimitedUntil = Math.max(
              state.rateLimitedUntil,
              now() + Math.max(policy.cooldownMs, retryAfterMs ?? 0),
            );
          }
          finish(
            outcome,
            failure?.code === 'rate_limit'
              ? state.rateLimitedUntil - now()
              : undefined,
          );
          if (usage) {
            stats.inputTokens += usage.inputTokens;
            stats.outputTokens += usage.outputTokens;
            stats.usageReports++;
          }
          if (!usage && failure?.code === 'rate_limit')
            stats.rateLimitedCalls = (stats.rateLimitedCalls ?? 0) + 1;
          if (capture)
            captureArtifact('llm_exchange', {
              provider: backend.name,
              model,
              purpose: request.purpose,
              input: messages,
              output: captured,
              outcome: failure?.code ?? outcome,
            });
          tracer?.emit({
            requestId,
            stage: 'llm',
            type: 'attempt',
            ts: new Date().toISOString(),
            durationMs: Math.max(0, now() - started),
            attrs: {
              provider: backend.name,
              model,
              retry,
              fallback,
              outcome:
                failure?.code ?? (outcome === 'success' ? 'ok' : 'aborted'),
              ...(failure?.code === 'rate_limit'
                ? { retryAfterMs: Math.max(0, state.rateLimitedUntil - now()) }
                : {}),
              ...(usage ?? {}),
            },
          });
        }

        if (!failure) {
          if (!stream) yield { type: 'token', text };
          yield { type: 'done', stats };
          return;
        }

        error = failure.code;
        if (error === 'aborted' || (stream && sent)) {
          yield { type: 'error', error, stats };
          return;
        }

        const jitter = Math.floor(
          policy.backoffMs * 2 ** retry * (0.5 + random() / 2),
        );
        if (
          !transient(error) ||
          error === 'rate_limit' ||
          request.skipProviderRetries ||
          retry === policy.retries ||
          stats.calls >= maxCalls ||
          jitter > policy.maxRetryWaitMs
        )
          break;
        try {
          await sleep(jitter, request.signal);
        } catch {
          break;
        }
      }
    }
    yield {
      type: 'error',
      error: request.signal?.aborted
        ? 'aborted'
        : error === 'circuit_open' && skippedRateLimit
          ? 'rate_limit'
          : error,
      stats,
    };
  }

  async function collect(
    request: LLMRequest,
    stats: LLMStats,
    suffix?: string,
    validate?: (text: string) => Promise<boolean>,
  ): Promise<LLMResult<string>> {
    let text = '';
    for await (const event of execute(
      request,
      false,
      stats,
      suffix,
      validate,
    )) {
      if (event.type === 'token') text += event.text;
      if (event.type === 'error')
        return { ok: false, error: event.error, stats };
    }
    return { ok: true, value: text, stats };
  }

  return {
    generate: (request) => collect(request, emptyStats()),
    stream: (request) => execute(request, true, emptyStats()),
    async generateStructured<S extends z.ZodType>(
      request: LLMRequest,
      schema: S,
    ): Promise<LLMResult<z.output<S>>> {
      const stats = emptyStats();
      const system =
        request.includeSchemaInPrompt === false
          ? request.system
          : request.system +
            '\n\nReturn only JSON matching this schema:\n' +
            JSON.stringify(
              z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
            );
      const structuredRequest = {
        ...request,
        system,
        requestId: request.requestId ?? randomUUID(),
      };
      if (request.skipProviderRetries) {
        let validated: { value: z.output<S> } | undefined;
        const result = await collect(
          structuredRequest,
          stats,
          undefined,
          async (text) => {
            const data = parseJson(text);
            if (data === invalidJson) return false;
            const value = await schema.safeParseAsync(data);
            if (!value.success) return false;
            validated = { value: value.data };
            return true;
          },
        );
        if (!result.ok) return result;
        return validated
          ? { ok: true, value: validated.value, stats }
          : { ok: false, error: 'invalid_output', stats };
      }

      for (
        let attempt = 0;
        attempt < 2 && stats.calls < (request.maxProviderCalls ?? Infinity);
        attempt++
      ) {
        const suffix = attempt
          ? 'The prior response failed JSON validation. Return a valid JSON value without Markdown.'
          : undefined;
        const result = await collect(structuredRequest, stats, suffix);
        if (!result.ok) {
          if (result.error === 'invalid_output') continue;
          return result;
        }
        const data = parseJson(result.value);
        if (data === invalidJson) continue;
        const value = await schema.safeParseAsync(data);
        if (value.success) return { ok: true, value: value.data, stats };
      }
      return { ok: false, error: 'invalid_output', stats };
    },
  };
}
