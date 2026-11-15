import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { chdir, loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { openChatRuntime } from './chat/runtime.js';
import { readEnv } from './config/index.js';
import { createApp } from './http/app.js';
import { createTracer } from './telemetry/tracer.js';

const write = (line: string) => process.stdout.write(line + '\n');
const workspace = new URL('../../../', import.meta.url);
if (existsSync(new URL('pnpm-workspace.yaml', workspace)))
  chdir(fileURLToPath(workspace));
const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
const { HOST, PORT, REDIS_URL } = readEnv(process.env);
const tracer = createTracer(write);
const chat = openChatRuntime(process.env, REDIS_URL, tracer);
const app = createApp(write, chat.routes);
const server = serve(
  { fetch: app.fetch, hostname: HOST, port: PORT },
  ({ port }) => {
    tracer.emit({
      requestId: 'startup',
      stage: 'http',
      type: 'listening',
      ts: new Date().toISOString(),
      attrs: { port },
    });
  },
);

const shutdown = () => server.close(() => chat.close());
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
