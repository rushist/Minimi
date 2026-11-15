import type { TraceEvent } from '@chatagent/shared';
import type { ArtifactKind } from './scope.js';
import type { TraceStore } from './sqlite.js';

export function createRequestTraces(
  now = Date.now,
  options: {
    store?: TraceStore;
    redact?: (text: string) => string;
    remote?: (event: TraceEvent) => void;
  } = {},
) {
  const redact = options.redact ?? ((value: string) => value);
  const requests = new Map<
    string,
    {
      owner: string;
      expires: number;
      events: TraceEvent[];
      replay: boolean;
      public: boolean;
      artifacts: number;
    }
  >();
  const listeners = new Map<string, Set<(event: TraceEvent) => void>>();
  return {
    begin(
      owner: string,
      requestId: string,
      visibility: 'public' | 'private' = 'private',
      replay = false,
    ) {
      const timestamp = now();
      requests.set(requestId, {
        owner,
        expires: timestamp + 30 * 60_000,
        events: [],
        replay,
        public: visibility === 'public',
        artifacts: 0,
      });
      if (requests.size > 256) requests.delete(requests.keys().next().value!);
      options.store?.enqueue({
        kind: 'begin',
        owner,
        requestId,
        ts: new Date(timestamp).toISOString(),
      });
    },
    record(event: TraceEvent, progress = false): TraceEvent {
      const safe: TraceEvent = {
        ...event,
        attrs: Object.fromEntries(
          Object.entries(event.attrs).map(([key, value]) => [
            key,
            typeof value === 'string' ? redact(value) : value,
          ]),
        ),
      };
      const trace = requests.get(safe.requestId);
      if (trace && trace.expires > now()) {
        if (trace.events.length < 128) {
          trace.events.push(safe);
          options.store?.enqueue({ kind: 'event', event: safe });
          if (trace.public) options.remote?.(safe);
        }
        if (progress || safe.type === 'span_start') {
          for (const send of listeners.get(safe.requestId) ?? []) send(safe);
        }
      }
      return safe;
    },
    subscribe(requestId: string, send: (event: TraceEvent) => void) {
      const set = listeners.get(requestId) ?? new Set();
      listeners.set(requestId, set);
      set.add(send);
      return () => {
        set.delete(send);
        if (!set.size) listeners.delete(requestId);
      };
    },
    artifact(requestId: string, kind: ArtifactKind, value: unknown) {
      const trace = requests.get(requestId);
      if (
        !trace?.public ||
        !trace.replay ||
        trace.artifacts >= 24 ||
        !options.store
      )
        return;
      try {
        const serialized = JSON.stringify(value, (key, field: unknown) =>
          typeof field === 'string'
            ? /^(?:authorization|api[_-]?key|token|password|secret)$/i.test(key)
              ? '[REDACTED]'
              : redact(field)
            : field,
        );
        if (!serialized) return;
        const truncated = serialized.length > 64_000;
        trace.artifacts++;
        options.store.enqueue({
          kind: 'artifact',
          requestId,
          artifact: kind,
          truncated,
          payload: truncated
            ? JSON.stringify({ preview: serialized.slice(0, 64_000) })
            : serialized,
        });
      } catch {
        /* Replay capture must not interrupt the request. */
      }
    },
    read(owner: string, requestId: string) {
      const trace = requests.get(requestId);
      if (trace?.owner === owner && trace.expires > now()) return trace.events;
      try {
        return options.store?.read(owner, requestId);
      } catch {
        return;
      }
    },
  };
}

export type RequestTraces = ReturnType<typeof createRequestTraces>;
