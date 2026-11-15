import { createHash, randomBytes } from 'node:crypto';
import type { TraceEvent } from '@chatagent/shared';

const regions = new Set([
  'cloud.langfuse.com',
  'us.cloud.langfuse.com',
  'jp.cloud.langfuse.com',
]);
const rootId = (requestId: string) =>
  createHash('sha256').update(requestId).digest('hex').slice(0, 16);

export function createLangfuseSink(
  base: string,
  publicKey: string,
  secretKey: string,
  fetcher: typeof fetch = fetch,
) {
  const url = new URL(base);
  if (
    url.protocol !== 'https:' ||
    !regions.has(url.host) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid Langfuse Cloud origin');
  const endpoint = new URL('/api/public/otel/v1/traces', url);
  const authorization =
    'Basic ' + Buffer.from(publicKey + ':' + secretKey).toString('base64');
  const queue: TraceEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let stopped = false;

  function schedule() {
    if (timer || sending || !queue.length || stopped) return;
    timer = setTimeout(() => void flush(), 350);
    timer.unref();
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (sending || !queue.length || stopped) return;
    sending = true;
    const spans = queue.splice(0).map((event) => {
      const root = event.type === 'chat_finished';
      const end = BigInt(Date.parse(event.ts)) * 1_000_000n;
      const start =
        end - BigInt(Math.round((event.durationMs ?? 0) * 1_000_000));
      const metadata = Object.entries(event.attrs).flatMap<{
        key: string;
        value:
          | { stringValue: string }
          | { doubleValue: number }
          | { boolValue: boolean };
      }>(([key, value]) => {
        if (typeof value === 'string')
          return [{ key: 'chatagent.' + key, value: { stringValue: value } }];
        if (typeof value === 'number')
          return [{ key: 'chatagent.' + key, value: { doubleValue: value } }];
        if (typeof value === 'boolean')
          return [{ key: 'chatagent.' + key, value: { boolValue: value } }];
        return [];
      });
      return {
        traceId: event.requestId.replaceAll('-', ''),
        spanId: root ? rootId(event.requestId) : randomBytes(8).toString('hex'),
        ...(!root ? { parentSpanId: rootId(event.requestId) } : {}),
        name: root ? 'chat' : event.stage + '.' + event.type,
        kind: 1,
        startTimeUnixNano: start.toString(),
        endTimeUnixNano: end.toString(),
        attributes: metadata,
      };
    });
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(2500),
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'x-langfuse-ingestion-version': '4',
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              resource: {
                attributes: [
                  { key: 'service.name', value: { stringValue: 'chatagent' } },
                ],
              },
              scopeSpans: [{ scope: { name: 'chatagent' }, spans }],
            },
          ],
        }),
      });
      await response.body?.cancel();
    } catch {
      /* Optional export is best effort. */
    } finally {
      sending = false;
      schedule();
    }
  }

  return {
    push(event: TraceEvent) {
      if (
        stopped ||
        queue.length >= 128 ||
        !['span', 'attempt', 'chat_finished'].includes(event.type) ||
        !/^[a-f0-9-]{36}$/i.test(event.requestId)
      )
        return;
      queue.push(event);
      schedule();
    },
    flush,
    close() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
