import { serve } from '@hono/node-server';
import {
  StreamEventSchema,
  type AnswerResult,
  type StreamEvent,
} from '@chatagent/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ChatPipeline } from '../chat/pipeline.js';
import { openConversationStore } from '../store/conversations.js';
import { createRequestTraces } from '../telemetry/request-traces.js';
import { createApp } from './app.js';
import { createRateLimiter } from './rate-limit.js';

const answer: AnswerResult = {
  status: 'complete',
  markdown: 'Verified evidence [S1]',
  confidence: 'medium',
  conflictingSources: false,
  claims: [],
  usage: { tokensUsed: 10, llmCalls: 1 },
};
const start = (requestId: string): StreamEvent => ({
  type: 'step',
  event: {
    requestId,
    stage: 'planner',
    type: 'planning',
    ts: '2026-11-12T00:00:00Z',
    attrs: {},
  },
});
const normal: ChatPipeline = async function* ({ requestId }) {
  yield start(requestId);
  yield { type: 'token', text: answer.markdown, provisional: true };
  yield { type: 'citation', id: 'S1' };
  yield {
    type: 'verification',
    claim: {
      text: 'Verified evidence',
      citedIds: ['S1'],
      verdict: 'supported',
    },
  };
  yield { type: 'done', requestId, answer };
};
function fixture(run = normal, limit = 20) {
  const { store, close } = openConversationStore(':memory:');
  const app = createApp(() => {}, {
    run,
    conversations: store,
    traces: createRequestTraces(),
    quota: { snapshot: () => [] },
    rate: createRateLimiter(limit, 60),
    ip: async () => '127.0.0.1',
    secureCookie: false,
    allowedOrigins: ['http://localhost:5173'],
  });
  return { app, close };
}
function post(
  message: string,
  cookie?: string,
  conversationId?: string,
  visibility = 'public',
) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ message, visibility, conversationId }),
  };
}
const session = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0]!;
async function events(response: Response) {
  return (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
      return StreamEventSchema.parse(JSON.parse(data.slice(6)));
    });
}

describe('chat HTTP API', () => {
  it('requires explicit hosted consent when public web search is off', async () => {
    const run = vi.fn(normal);
    const { app, close } = fixture(run);
    try {
      for (const allowHostedWithoutWeb of [false, true]) {
        const input = post('Answer without the web');
        await events(
          await app.request('/api/chat', {
            ...input,
            body: JSON.stringify({
              ...JSON.parse(input.body),
              webSearch: 'off',
              allowHostedWithoutWeb,
            }),
          }),
        );
      }
      expect(run.mock.calls.map(([value]) => value.visibility)).toEqual([
        'private',
        'public',
      ]);
    } finally {
      close();
    }
  });
  it('archives, restores, and deletes chats only for the owning session', async () => {
    const { app, close } = fixture();
    try {
      const response = await app.request('/api/chat', post('Manage this chat'));
      const id = response.headers.get('x-conversation-id')!;
      const cookie = session(response);
      await events(response);
      const path = '/api/conversations/' + id;
      const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
      const patch = (archived: boolean) => ({
        method: 'PATCH',
        headers,
        body: JSON.stringify({ archived }),
      });
      expect((await app.request(path, { method: 'DELETE' })).status).toBe(404);
      expect((await app.request(path, patch(true))).status).toBe(204);
      expect(
        await (await app.request('/api/conversations', { headers })).json(),
      ).toEqual({ conversations: [] });
      expect(
        await (
          await app.request('/api/conversations?includeArchived=true', {
            headers,
          })
        ).json(),
      ).toMatchObject({ conversations: [{ id, archived: true }] });
      expect((await app.request(path, patch(false))).status).toBe(204);
      expect(
        await (await app.request('/api/conversations', { headers })).json(),
      ).toMatchObject({ conversations: [{ id }] });
      expect(
        (await app.request(path, { method: 'DELETE', headers })).status,
      ).toBe(204);
      expect((await app.request(path, { headers })).status).toBe(404);
    } finally {
      close();
    }
  });

  it('streams ordered events, returns request IDs, and scopes history and traces to the session', async () => {
    const { app, close } = fixture();
    try {
      const response = await app.request('/api/chat', post('Public question'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const cookie = session(response);
      const id = response.headers.get('x-conversation-id')!;
      const requestId = response.headers.get('x-request-id');
      const output = await events(response);
      expect(output.map(({ type }) => type)).toEqual([
        'step',
        'token',
        'citation',
        'verification',
        'done',
      ]);
      expect(output.at(-1)).toMatchObject({ requestId, answer });
      const own = { headers: { Cookie: cookie } };
      expect(
        await (await app.request('/api/conversations', own)).json(),
      ).toMatchObject({ conversations: [{ id }] });
      expect(
        await (await app.request('/api/conversations/' + id, own)).json(),
      ).toMatchObject({
        turns: [
          { role: 'user', content: 'Public question' },
          { role: 'assistant', answer },
        ],
      });
      expect(
        await (await app.request('/api/trace/' + requestId, own)).json(),
      ).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ stage: 'planner' }),
        ]),
      });
      expect((await app.request('/api/conversations/' + id)).status).toBe(404);
      expect((await app.request('/api/trace/' + requestId)).status).toBe(404);
      expect(
        (await app.request('/api/chat', post('Foreign attempt', undefined, id)))
          .status,
      ).toBe(404);
      expect(await (await app.request('/api/quota')).json()).toEqual({
        quotas: [],
      });
    } finally {
      close();
    }
  });

  it('gives the hosted pipeline only public conversation history and a bounded rolling summary', async () => {
    const run = vi.fn<ChatPipeline>(normal);
    const { app, close } = fixture(run);
    try {
      const first = await app.request(
        '/api/chat',
        post('Private text', undefined, undefined, 'private'),
      );
      const cookie = session(first);
      const id = first.headers.get('x-conversation-id')!;
      await events(first);
      for (let index = 0; index < 6; index++)
        await events(
          await app.request('/api/chat', post('Public ' + index, cookie, id)),
        );
      const history = run.mock.calls.at(-1)![0].history;
      expect(history.summary).toContain('Public 0');
      expect(history.turns).toHaveLength(6);
      expect(JSON.stringify(history)).not.toContain('Private text');
    } finally {
      close();
    }
  });

  it('responds with 429 and Retry-After when the per-IP window is full', async () => {
    const { app, close } = fixture(normal, 1);
    try {
      await events(await app.request('/api/chat', post('First')));
      const blocked = await app.request('/api/chat', post('Second'));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await blocked.json()).toMatchObject({
        error: { code: 'rate_limit' },
      });
    } finally {
      close();
    }
  });

  it('allows configured origins, rejects foreign origins, and validates request bodies', async () => {
    const { app, close } = fixture();
    try {
      const preflight = await app.request('/api/chat', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:5173',
      );
      expect(preflight.headers.get('access-control-allow-credentials')).toBe(
        'true',
      );
      expect(
        (
          await app.request('/api/chat', {
            ...post('Hi'),
            headers: { Origin: 'http://foreign.example' },
          })
        ).status,
      ).toBe(403);
      expect((await app.request('/api/chat', post(''))).status).toBe(400);
      expect(
        (
          await app.request('/api/chat', {
            ...post('x'.repeat(70_000)),
            headers: { 'Content-Length': '70070' },
          })
        ).status,
      ).toBe(413);
    } finally {
      close();
    }
  });

  it('cancels work on a real HTTP disconnect and releases the conversation lease', async () => {
    let aborted = false;
    const run: ChatPipeline = async function* (job) {
      if (job.message === 'Complete') {
        yield* normal(job);
        return;
      }
      yield start(job.requestId);
      await new Promise<void>((resolve) => {
        const stop = () => {
          aborted = true;
          resolve();
        };
        if (job.signal.aborted) stop();
        else job.signal.addEventListener('abort', stop, { once: true });
      });
    };
    const { app, close } = fixture(run);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await new Promise<void>((resolve, reject) => {
        if (server.listening) resolve();
        else {
          server.once('listening', resolve);
          server.once('error', reject);
        }
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing HTTP address');
      const url = 'http://127.0.0.1:' + address.port + '/api/chat';
      const first = await fetch(url, post('Complete'));
      const cookie = session(first);
      const id = first.headers.get('x-conversation-id')!;
      await events(first);
      const controller = new AbortController();
      const slow = await fetch(url, {
        ...post('Interrupted', cookie, id),
        signal: controller.signal,
      });
      const reader = slow.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        'event: step',
      );
      const busy = await fetch(url, post('Complete', cookie, id));
      expect(busy.status).toBe(409);
      await busy.text();
      controller.abort();
      await reader.cancel().catch(() => {});
      await vi.waitFor(() => expect(aborted).toBe(true));
      const retry = await fetch(url, post('Complete', cookie, id));
      expect(retry.status).toBe(200);
      await events(retry);
      const history = await (
        await app.request('/api/conversations/' + id, {
          headers: { Cookie: cookie },
        })
      ).json();
      expect(JSON.stringify(history)).not.toContain('Interrupted');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      close();
    }
  });
});
