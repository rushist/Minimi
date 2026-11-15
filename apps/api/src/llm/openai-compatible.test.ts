import { describe, expect, it, vi } from 'vitest';
import { openAICompatible } from './openai-compatible.js';
import type { BackendRequest } from './types.js';

const config = {
  name: 'provider',
  baseUrl: 'https://provider.example/v1',
  apiKey: 'fake-key',
  models: { small: 'small', strong: 'strong' },
  streamUsageOption: true,
};
const request: BackendRequest = {
  model: 'small',
  messages: [{ role: 'user', content: 'Hi' }],
  stream: false,
};

describe('OpenAI-compatible adapter', () => {
  it('validates and maps a completion and token usage', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    );
    const events = [];
    for await (const event of openAICompatible(config, fetcher).complete(
      request,
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
      { type: 'token', text: 'hello' },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://provider.example/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'small',
          messages: request.messages,
          stream: false,
        }),
        redirect: 'error',
      }),
    );
  });

  it('decodes split SSE frames and counts usage even when choices are empty', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hé"}}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const bytes = new TextEncoder().encode(frames);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const backend = openAICompatible(config, async () => new Response(body));
    const events = [];
    for await (const event of backend.complete(
      { ...request, stream: true },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: 'token', text: 'hé' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
  });

  it('preserves Retry-After on 429 responses', async () => {
    const backend = openAICompatible(
      config,
      async () =>
        new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
    );
    const iterable = backend.complete(request, new AbortController().signal);
    const events = iterable[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toMatchObject({
      code: 'rate_limit',
      retryAfterMs: 2000,
    });
  });
});
