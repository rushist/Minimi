import { readTraceEnv } from '../config/telemetry.js';
import { openTraceStore } from './sqlite.js';

const store = openTraceStore(readTraceEnv(process.env).TRACE_DB_PATH);
try {
  const requestId = process.argv[2];
  const output = requestId
    ? { requestId, artifacts: store.artifacts(requestId) }
    : store.metrics();
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} finally {
  store.close();
}
