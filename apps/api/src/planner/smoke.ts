import { randomUUID } from 'node:crypto';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { configureLLM } from '../llm/index.js';
import { createTracer } from '../telemetry/tracer.js';
import { createPlanner } from './index.js';

const requestId = randomUUID();
const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const { meter, close } = configureQuota(readSearchEnv(process.env));
try {
  const makePlan = createPlanner(configureLLM(process.env, tracer, meter));
  const result = await makePlan(
    {
      visibility: 'public',
      summary: 'The discussion is about the Node.js built-in test runner.',
      turns: [
        {
          role: 'user',
          content:
            'Does the Node.js test runner support running tests concurrently?',
        },
      ],
      message:
        'What about setting a timeout? Use only official docs and skip Wikipedia.',
    },
    { requestId },
  );
  if (
    !result.ok ||
    result.origin !== 'model' ||
    result.stats.calls !== 1 ||
    result.plan.route === 'no_search' ||
    !result.plan.specs.length ||
    !result.plan.specs.every(
      (spec) =>
        spec.includeDomains.includes('nodejs.org') &&
        spec.excludeDomains.includes('wikipedia.org'),
    ) ||
    !/node(?:\.js|js)/i.test(result.plan.standaloneQuery)
  ) {
    throw new Error(
      'Unexpected live planner result: ' +
        (result.ok ? result.origin + '/' + result.plan.route : result.error),
    );
  }
  tracer.emit({
    requestId,
    stage: 'planner',
    type: 'smoke_passed',
    ts: new Date().toISOString(),
    attrs: {
      route: result.plan.route,
      specs: result.plan.specs.length,
      calls: result.stats.calls,
    },
  });
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'planner',
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
