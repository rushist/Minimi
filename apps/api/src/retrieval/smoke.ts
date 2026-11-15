import { randomUUID } from 'node:crypto';
import { readRetrievalEnv } from '../config/retrieval.js';
import { createTracer } from '../telemetry/tracer.js';
import { configureRetriever } from './index.js';
import type { Source } from './types.js';

const requestId = randomUUID();
const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const retrievedAt = '2026-11-12T00:00:00Z';
const sources: Source[] = [
  {
    url: 'https://example.org/power',
    title: 'Power settings',
    retrievedAt,
    text: 'Reduce screen brightness and close unused applications to extend the notebook runtime between charges.',
  },
  {
    url: 'https://example.org/garden',
    title: 'Garden guide',
    retrievedAt,
    text: 'A vegetable garden needs rich soil, adequate sunshine and regular watering.',
  },
];
try {
  const retrieve = configureRetriever(process.env);
  const result = await retrieve({
    query: 'How do I improve laptop battery life?',
    sources,
    topK: 1,
  });
  if (
    !result.ok ||
    !result.value.embeddingUsed ||
    result.value.passages[0]?.url !== sources[0]!.url
  ) {
    throw new Error(
      'Local embedding did not return the expected paraphrase match',
    );
  }
  let reranked = false;
  if (readRetrievalEnv(process.env).RETRIEVAL_RERANK_ENABLED === 'true') {
    const ranked = await retrieve({
      query: 'Berlin population',
      sources: [
        {
          url: 'https://example.org/1',
          title: 'Berlin',
          retrievedAt,
          text: 'Berlin is known for art museums and parks.',
        },
        {
          url: 'https://example.org/2',
          title: 'Berlin population',
          retrievedAt,
          text: 'Berlin has a population of approximately 3.8 million residents.',
        },
      ],
    });
    if (
      !ranked.ok ||
      !ranked.value.reranked ||
      ranked.value.passages[0]?.url !== 'https://example.org/2'
    ) {
      throw new Error('Local reranker did not return the expected passage');
    }
    reranked = true;
  }
  tracer.emit({
    requestId,
    stage: 'retrieval',
    type: 'smoke_passed',
    ts: new Date().toISOString(),
    attrs: { embeddingUsed: true, reranked },
  });
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'retrieval',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
}
