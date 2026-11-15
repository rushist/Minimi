import { randomUUID } from 'node:crypto';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { createTracer } from '../telemetry/tracer.js';
import { configureSearch } from './index.js';

const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const requestId = randomUUID();
try {
  const config = readSearchEnv(process.env);
  const { meter, close } = configureQuota(config);
  try {
    const result = await configureSearch(config, meter).search({
      query: 'Node.js official documentation for the built-in test runner',
      exactPhrases: [],
      includeDomains: ['nodejs.org'],
      excludeDomains: [],
      intent: 'official_docs',
      topic: 'general',
      volatility: 'slow',
    });
    if (!result.ok || !result.results.length)
      throw new Error(result.ok ? 'no_results' : result.error);
    tracer.emit({
      requestId,
      stage: 'search',
      type: 'smoke_passed',
      ts: new Date().toISOString(),
      attrs: {
        provider: result.results[0]!.provider,
        count: result.results.length,
        mode: config.SEARCH_MODE,
      },
    });
  } finally {
    close();
  }
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'search',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
}
