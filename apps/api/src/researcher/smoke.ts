import { randomUUID } from 'node:crypto';
import type { Plan } from '@chatagent/shared';
import { createEvidenceCache } from '../cache/evidence.js';
import { openCacheStore } from '../cache/redis.js';
import { configurePageFetcher } from '../config/fetch.js';
import { readEnv } from '../config/index.js';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { configureLLM } from '../llm/index.js';
import { configureRetriever } from '../retrieval/index.js';
import { configureSearch } from '../search/index.js';
import { createTracer } from '../telemetry/tracer.js';
import { createResearcher } from './index.js';

const requestId = randomUUID();
const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const searchConfig = readSearchEnv(process.env);
const { meter, close } = configureQuota(searchConfig);
const runtime = openCacheStore(readEnv(process.env).REDIS_URL);
const cache = createEvidenceCache(runtime.store);
const message = 'Who wrote Pride and Prejudice?';
const plan: Plan = {
  route: 'quick',
  standaloneQuery: message,
  subQuestions: [],
  answerShape: 'short',
  specs: [
    {
      query: 'Who wrote the novel Pride and Prejudice?',
      exactPhrases: [],
      includeDomains: [],
      excludeDomains: [],
      topic: 'general',
      intent: 'general',
      volatility: 'slow',
    },
  ],
};
try {
  const research = createResearcher({
    search: configureSearch(searchConfig, meter, cache),
    fetchPage: configurePageFetcher(process.env, cache),
    retrieve: configureRetriever(process.env, cache),
    llm: configureLLM(process.env, tracer, meter),
    quota: meter,
  });
  const result = await research(
    { plan, message, visibility: 'public' },
    { requestId },
  );
  if (
    !result.ok ||
    result.value.status !== 'complete' ||
    !result.value.passages.some(({ text }) => /jane austen/i.test(text))
  ) {
    const reason = !result.ok
      ? result.error
      : result.value.status === 'complete'
        ? 'unexpected_evidence'
        : result.value.reason;
    throw new Error(
      'Research did not confirm the synthetic question: ' + reason,
    );
  }
  tracer.emit({
    requestId,
    stage: 'research',
    type: 'smoke_passed',
    ts: new Date().toISOString(),
    attrs: {
      status: result.value.status,
      passages: result.value.passages.length,
      ...result.value.usage,
    },
  });
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'research',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
} finally {
  runtime.close();
  close();
}
