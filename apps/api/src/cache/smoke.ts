import { randomUUID } from 'node:crypto';
import { readEnv } from '../config/index.js';
import { configurePageFetcher } from '../config/fetch.js';
import { createTracer } from '../telemetry/tracer.js';
import { createEvidenceCache } from './evidence.js';
import { openCacheStore } from './redis.js';

const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const requestId = randomUUID();
const { REDIS_URL } = readEnv(process.env);
const first = openCacheStore(REDIS_URL);
const second = openCacheStore(REDIS_URL);
const url = 'https://example.com/?cache-check=' + requestId;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    Promise.all([first.ready, second.ready]),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Redis connection timed out')),
        1500,
      );
    }),
  ]);
  const fetched = await configurePageFetcher(
    process.env,
    createEvidenceCache(first.store),
  )(url, undefined, 'fast');
  if (!fetched.ok) throw new Error('Page fetch failed: ' + fetched.error);
  const cached = await createEvidenceCache(second.store).page(
    url,
    'fast',
    async () => {
      throw new Error('Redis evidence was not shared across clients');
    },
  );
  if (!cached.ok || fetched.page.text !== cached.page.text)
    throw new Error('Cached evidence differs from extracted page');
  tracer.emit({
    requestId,
    stage: 'cache',
    type: 'smoke_passed',
    ts: new Date().toISOString(),
    attrs: { backend: 'redis', chars: cached.page.text.length },
  });
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'cache',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  first.close();
  second.close();
}
