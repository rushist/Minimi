import { randomUUID } from 'node:crypto';
import { configurePageFetcher } from '../config/fetch.js';
import { createTracer } from '../telemetry/tracer.js';

const tracer = createTracer((line) => process.stdout.write(line + '\n'));
const result = await configurePageFetcher(process.env)(
  process.argv[2] ?? 'https://example.com/',
);
tracer.emit({
  requestId: randomUUID(),
  stage: 'fetch',
  type: result.ok ? 'smoke_passed' : 'smoke_failed',
  ts: new Date().toISOString(),
  attrs: result.ok
    ? { kind: result.page.kind, chars: result.page.text.length }
    : { error: result.error },
});
if (!result.ok) process.exitCode = 1;
