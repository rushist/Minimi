import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceEvent } from '@chatagent/shared';
import type { Tracer } from './tracer.js';

export type ArtifactKind = 'search_response' | 'llm_exchange' | 'page_excerpt';
interface Scope {
  requestId: string;
  tracer: Tracer;
  capture?: (kind: ArtifactKind, value: unknown) => void;
}
const scopes = new AsyncLocalStorage<Scope>();
export const withTrace = <T>(scope: Scope, work: () => T): T =>
  scopes.run(scope, work);
export const capturingArtifacts = () => Boolean(scopes.getStore()?.capture);
export function captureArtifact(kind: ArtifactKind, value: unknown) {
  scopes.getStore()?.capture?.(kind, value);
}
export function traceEvent(
  stage: string,
  type: string,
  attrs: TraceEvent['attrs'],
  durationMs?: number,
) {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.tracer.emit({
    requestId: scope.requestId,
    stage,
    type,
    attrs,
    ts: new Date().toISOString(),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
}
export function startSpan(
  stage: string,
  attrs: TraceEvent['attrs'] = {},
  progress = false,
) {
  const start = performance.now();
  if (progress) traceEvent(stage, 'span_start', attrs);
  return (result: TraceEvent['attrs'] = {}) =>
    traceEvent(
      stage,
      'span',
      { ...attrs, ...result },
      performance.now() - start,
    );
}
export async function traceSpan<T>(
  stage: string,
  run: () => Promise<T>,
  attrs: TraceEvent['attrs'] = {},
  progress = false,
) {
  const end = startSpan(stage, attrs, progress);
  try {
    const result = await run();
    const error =
      result &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok === false;
    const code =
      error && 'error' in result && typeof result.error === 'string'
        ? result.error
        : undefined;
    end({ outcome: error ? 'error' : 'ok', ...(code ? { error: code } : {}) });
    return result;
  } catch (error) {
    end({ outcome: 'error' });
    throw error;
  }
}
