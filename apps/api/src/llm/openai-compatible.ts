import { z } from 'zod';
import { LLMFailure, type ModelBackend } from './types.js';

const count = z.number().int().nonnegative();
const usageSchema = z
  .object({ prompt_tokens: count, completion_tokens: count })
  .transform(({ prompt_tokens, completion_tokens }) => ({
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
  }));
const completionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
  usage: usageSchema.nullish(),
});
const streamSchema = z.object({
  choices: z.array(
    z.object({ delta: z.object({ content: z.string().nullish() }) }),
  ),
  usage: usageSchema.nullish(),
  x_groq: z.object({ usage: usageSchema.nullish() }).nullish(),
});

interface BackendConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelBackend['models'];
  streamUsageOption: boolean;
}

function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new LLMFailure('invalid_output');
  return result.data;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new LLMFailure('invalid_output');
  }
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const ms = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  if (Number.isFinite(ms)) return Math.max(0, Math.ceil(ms));
}

async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:'))
          data.push(line.slice(5).replace(/^ /, ''));
        if (!line && data.length) {
          yield data.join('\n');
          data = [];
        }
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function openAICompatible(
  config: BackendConfig,
  fetcher: typeof fetch = fetch,
): ModelBackend {
  return {
    name: config.name,
    models: config.models,
    async *complete(request, signal) {
      const response = await fetcher(config.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.apiKey,
          'Content-Type': 'application/json',
        },
        signal,
        redirect: 'error',
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: request.stream,
          ...(request.jsonObject
            ? { response_format: { type: 'json_object' } }
            : {}),
          ...(request.reasoningEffort &&
          ((config.name === 'groq' &&
            /^openai\/gpt-oss-(20b|120b)$/.test(request.model)) ||
            (config.name === 'gemini' && /^gemini-3[.-]/.test(request.model)))
            ? { reasoning_effort: request.reasoningEffort }
            : {}),
          ...(request.maxOutputTokens !== undefined
            ? { max_completion_tokens: request.maxOutputTokens }
            : {}),
          ...(request.stream && config.streamUsageOption
            ? { stream_options: { include_usage: true } }
            : {}),
        }),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429)
          throw new LLMFailure(
            'rate_limit',
            retryAfter(response.headers.get('retry-after')),
          );
        if (response.status >= 500 || response.status === 408)
          throw new LLMFailure('unavailable');
        throw new LLMFailure('rejected');
      }

      if (!request.stream) {
        const value = parse(completionSchema, parseJson(await response.text()));
        if (value.usage) yield { type: 'usage', usage: value.usage };
        yield { type: 'token', text: value.choices[0]!.message.content };
        return;
      }

      if (!response.body) throw new LLMFailure('invalid_output');
      for await (const frame of sseData(response.body)) {
        if (frame === '[DONE]') return;
        const value = parse(streamSchema, parseJson(frame));
        const usage = value.usage ?? value.x_groq?.usage;
        if (usage) yield { type: 'usage', usage };
        const text = value.choices[0]?.delta.content;
        if (text) yield { type: 'token', text };
      }
      throw new LLMFailure('unavailable');
    },
  };
}
