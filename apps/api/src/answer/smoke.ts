import { randomUUID } from 'node:crypto';
import type { Passage } from '@chatagent/shared';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { configureLLM } from '../llm/index.js';
import { createTracer } from '../telemetry/tracer.js';
import { createAnswerer } from './index.js';

const requestId = randomUUID();
const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const { meter, close } = configureQuota(readSearchEnv(process.env));
const sources: Passage[] = [
  {
    id: 'S1',
    title: 'Synthetic literature evidence',
    domain: 'example.org',
    url: 'https://example.org/literature',
    text: 'Pride and Prejudice is a novel written by Jane Austen.',
    retrievedAt: new Date().toISOString(),
    scores: { bm25: 1, embedding: 0, fused: 0.1, sourceQuality: 0.5 },
  },
];

try {
  const answerer = createAnswerer(configureLLM(process.env, tracer, meter));
  const result = await answerer.answer(
    {
      visibility: 'public',
      plan: {
        route: 'quick',
        standaloneQuery: 'Who wrote Pride and Prejudice?',
        subQuestions: [],
        specs: [],
        answerShape: 'short',
      },
      research: {
        status: 'complete',
        degraded: false,
        passages: sources,
        coverage: [],
        usage: {
          loops: 0,
          searches: 0,
          pages: 0,
          searchCreditsUsed: 0,
          tokensUsed: 0,
          llmCalls: 0,
          elapsedMs: 0,
        },
      },
    },
    { requestId },
  );
  if (
    !result ||
    result.status !== 'complete' ||
    !/Jane Austen/i.test(result.markdown) ||
    !result.markdown.includes('[S1]')
  ) {
    throw new Error(
      'Unexpected answer result: ' +
        (result
          ? result.status + ' (' + result.claims.length + ' claims)'
          : 'missing'),
    );
  }
  tracer.emit({
    requestId,
    stage: 'answer',
    type: 'smoke_passed',
    ts: new Date().toISOString(),
    attrs: {
      status: result.status,
      confidence: result.confidence,
      claims: result.claims.length,
      ...result.usage,
    },
  });
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'answer',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
} finally {
  close();
}
