import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { readLlmEnv } from '../config/llm.js';
import { createTracer } from '../telemetry/tracer.js';
import { configureLLM } from './index.js';

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const requestId = randomUUID();

async function run() {
  const configs = readLlmEnv(process.env);
  if (!configs.length) throw new Error('No LLM providers configured');
  for (const config of configs) {
    const response = await fetch(config.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + config.apiKey },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(config.name + ' catalog HTTP ' + response.status);
    const models = modelsSchema.parse(await response.json());
    const ids = new Set(
      models.data.map(({ id }) => id.replace(/^models\//, '')),
    );
    for (const model of Object.values(config.models)) {
      if (!ids.has(model.replace(/^models\//, '')))
        throw new Error(
          config.name + ' configured model is absent from its catalog',
        );
    }
  }

  const { meter, close } = configureQuota(readSearchEnv(process.env));
  try {
    const result = await configureLLM(
      process.env,
      tracer,
      meter,
    ).generateStructured(
      {
        purpose: 'planner',
        system: 'Follow the requested output format.',
        context: 'Set ok to true.',
        requestId,
      },
      z.object({ ok: z.literal(true) }),
    );
    if (!result.ok) throw new Error('Completion failed: ' + result.error);
    tracer.emit({
      requestId,
      stage: 'llm',
      type: 'smoke_passed',
      ts: new Date().toISOString(),
      attrs: { ...result.stats },
    });
  } finally {
    close();
  }
}

try {
  await run();
} catch (error) {
  tracer.emit({
    requestId,
    stage: 'llm',
    type: 'smoke_failed',
    ts: new Date().toISOString(),
    attrs: {
      reason: error instanceof Error ? error.message : 'Unknown failure',
    },
  });
  process.exitCode = 1;
}
