import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLangfuseSink } from './langfuse.js';
import { createRedactor } from './redact.js';
import { createRequestTraces } from './request-traces.js';
import { captureArtifact, traceEvent, traceSpan, withTrace } from './scope.js';
import { openTraceStore } from './sqlite.js';

describe('request telemetry', () => {
  it('fans progress out once and reads persisted traces with the same owner after the live registry is gone', async () => {
    const store = openTraceStore(':memory:');
    try {
      const traces = createRequestTraces(Date.now, { store });
      const step = vi.fn();
      traces.begin('owner', 'req', 'public');
      const unsubscribe = traces.subscribe('req', step);
      await withTrace(
        {
          requestId: 'req',
          tracer: {
            emit: (event) => {
              traces.record(event);
            },
          },
        },
        () =>
          traceSpan(
            'fetch',
            async () => ({ ok: true }),
            { provider: 'fixture' },
            true,
          ),
      );
      unsubscribe();
      expect(step).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stage: 'fetch', type: 'span_start' }),
      );
      expect(traces.read('owner', 'req')).toHaveLength(2);
      expect(store.read('owner', 'req')).toBeUndefined();
      store.flush();
      const restarted = createRequestTraces(Date.now, { store });
      expect(restarted.read('owner', 'req')).toEqual(
        traces.read('owner', 'req'),
      );
      expect(restarted.read('other', 'req')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('produces SQL latency, cache hit rate and request credit summaries', () => {
    const store = openTraceStore(':memory:');
    try {
      const traces = createRequestTraces(Date.now, { store });
      traces.begin('owner', 'req', 'public');
      withTrace(
        {
          requestId: 'req',
          tracer: {
            emit: (event) => {
              traces.record(event);
            },
          },
        },
        () => {
          for (const duration of [5, 15, 30])
            traceEvent('search', 'span', { credits: 1 }, duration);
          traceEvent('cache', 'lookup', { layer: 'search', cacheHit: true });
          traceEvent('cache', 'lookup', { layer: 'search', cacheHit: false });
        },
      );
      store.flush();
      expect(store.metrics()).toEqual({
        latency: [{ stage: 'search', samples: 3, p50Ms: 15, p95Ms: 30 }],
        cache: [{ layer: 'search', lookups: 2, hitRate: 0.5 }],
        credits: [{ requestId: 'req', credits: 3 }],
      });
    } finally {
      store.close();
    }
  });

  it('captures redacted replay payloads only for opted-in public requests', () => {
    const store = openTraceStore(':memory:');
    const remote = vi.fn();
    try {
      const traces = createRequestTraces(Date.now, {
        store,
        remote,
        redact: createRedactor({ GROQ_API_KEY: 'configured-secret-123' }),
      });
      for (const [requestId, visibility, capture] of [
        ['public', 'public', true],
        ['opt-out', 'public', false],
        ['private', 'private', true],
      ] as const) {
        traces.begin('owner', requestId, visibility, capture);
        withTrace(
          {
            requestId,
            tracer: {
              emit: (event) => {
                traces.record(event);
              },
            },
            capture: (kind, value) => traces.artifact(requestId, kind, value),
          },
          () => {
            captureArtifact('llm_exchange', {
              input: 'configured-secret-123',
              api_key: 'unknown-credential',
              output: 'Bearer abcdefghijkl',
              nested: { token: 'arbitrary' },
            });
            traceEvent('llm', 'attempt', { model: 'configured-secret-123' });
          },
        );
      }
      store.flush();
      const entries = store.artifacts('public');
      expect(entries).toHaveLength(1);
      const text = JSON.stringify(entries);
      expect(text).toContain('[REDACTED]');
      expect(text).not.toMatch(
        /configured-secret-123|unknown-credential|abcdefghijkl|arbitrary/,
      );
      expect(store.artifacts('opt-out')).toEqual([]);
      expect(store.artifacts('private')).toEqual([]);
      expect(remote).toHaveBeenCalledTimes(2);
      expect(
        remote.mock.calls.every(([event]) => event.requestId !== 'private'),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it('exports an optional OTLP batch without waiting for it on the caller path', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200 }),
    );
    const sink = createLangfuseSink(
      'https://cloud.langfuse.com',
      'public-fake',
      'secret-fake',
      fetcher,
    );
    try {
      sink.push({
        requestId: randomUUID(),
        stage: 'verifier',
        type: 'span',
        ts: new Date().toISOString(),
        durationMs: 12,
        attrs: { outcome: 'ok' },
      });
      expect(fetcher).not.toHaveBeenCalled();
      await sink.flush();
      const [url, request] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(
        'https://cloud.langfuse.com/api/public/otel/v1/traces',
      );
      expect(request?.headers).toMatchObject({
        'x-langfuse-ingestion-version': '4',
      });
      expect(request?.body).toEqual(expect.stringContaining('verifier.span'));
      expect(request?.body).not.toEqual(expect.stringContaining('secret-fake'));
    } finally {
      sink.close();
    }
  });
});
