import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createTracer, type LogWriter } from '../telemetry/tracer.js';
import {
  apiError,
  chatRoutes,
  type ChatRoutes,
  type HttpEnv,
} from './routes.js';

export function createApp(write: LogWriter, chat?: ChatRoutes) {
  const output = createTracer(write);
  const tracer = {
    emit(event: Parameters<typeof output.emit>[0], progress?: boolean) {
      output.emit(chat?.traces.record(event, progress) ?? event);
    },
  };
  const app = new Hono<HttpEnv>();
  app.use('*', async (context, next) => {
    const start = performance.now();
    const requestId = randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-Id', requestId);
    await next();
    tracer.emit({
      requestId,
      stage: 'http',
      type: 'request',
      ts: new Date().toISOString(),
      durationMs: performance.now() - start,
      attrs: { method: context.req.method, status: context.res.status },
    });
  });
  app.onError((_error, context) => apiError(context, 'unavailable'));
  app.get('/health', (context) => context.json({ status: 'ok' as const }));
  if (chat) app.route('/api', chatRoutes(chat, tracer));
  return app;
}
