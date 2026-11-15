import { createHash, randomBytes } from 'node:crypto';
import {
  StreamEventSchema,
  MarketRangeSchema,
  type Passage,
  type StreamEvent,
} from '@chatagent/shared';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ChatPipeline } from '../chat/pipeline.js';
import type { ConversationStore } from '../store/conversations.js';
import type { QuotaMeter } from '../store/quota.js';
import type { RequestTraces } from '../telemetry/request-traces.js';
import type { Tracer } from '../telemetry/tracer.js';
import { withTrace } from '../telemetry/scope.js';
import { extractInWorker } from '../fetch/worker.js';
import {
  MarketDataError,
  marketErrorMessage,
  symbolSchema,
  type MarketData,
} from '../market/index.js';
import type { RateLimiter } from './rate-limit.js';

export type HttpEnv = { Variables: { requestId: string } };
export interface ChatRoutes {
  run: ChatPipeline;
  conversations: ConversationStore;
  rate: RateLimiter;
  ip(context: Context<HttpEnv>): Promise<string>;
  quota: Pick<QuotaMeter, 'snapshot'>;
  traces: RequestTraces;
  captureReplay?: boolean;
  market?: MarketData;
  allowedOrigins: readonly string[];
  secureCookie: boolean;
}

const chatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.uuid().optional(),
  visibility: z.enum(['public', 'private']).default('private'),
  webSearch: z.enum(['off', 'auto', 'on']).optional(),
  allowHostedWithoutWeb: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(6000),
      }),
    )
    .max(3)
    .default([])
    .refine(
      (files) =>
        files.reduce((size, file) => size + file.text.length, 0) <= 6000,
    ),
});
const cookieName = 'chatagent_session';
function owner(context: Context<HttpEnv>, secure: boolean, issue: boolean) {
  let token = getCookie(context, cookieName);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (!issue) return;
    token = randomBytes(32).toString('hex');
    setCookie(context, cookieName, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      path: '/api',
      maxAge: 30 * 24 * 60 * 60,
    });
  }
  return createHash('sha256').update(token).digest('hex');
}

const errors = {
  invalid_input: { status: 400, message: 'The request is invalid.' },
  origin_denied: { status: 403, message: 'This origin is not allowed.' },
  not_found: { status: 404, message: 'The requested resource was not found.' },
  busy: {
    status: 409,
    message: 'A response is already in progress for this conversation.',
  },
  body_too_large: { status: 413, message: 'The request body is too large.' },
  rate_limit: {
    status: 429,
    message: 'Too many chat requests. Try again shortly.',
  },
  unavailable: {
    status: 503,
    message: 'The service could not complete the request.',
  },
} as const;

export function apiError(context: Context<HttpEnv>, code: keyof typeof errors) {
  const { status, message } = errors[code];
  return context.json(
    { error: { code, message }, requestId: context.get('requestId') },
    status,
  );
}

export function chatRoutes(services: ChatRoutes, tracer: Tracer) {
  const app = new Hono<HttpEnv>();
  const origins = new Set(services.allowedOrigins);
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    const origin = context.req.header('origin');
    if (origin && !origins.has(origin))
      return apiError(context, 'origin_denied');
    await next();
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      exposeHeaders: ['X-Request-Id', 'X-Conversation-Id', 'Retry-After'],
    }),
  );

  app.get('/conversations', (context) => {
    const session = owner(context, services.secureCookie, true)!;
    const archived =
      context.req.query('includeArchived') === 'true'
        ? services.conversations.list(session, true)
        : [];
    return context.json({
      conversations: [...services.conversations.list(session), ...archived],
    });
  });
  app.patch(
    '/conversations/:id',
    bodyLimit({
      maxSize: 1024,
      onError: (context) => apiError(context, 'body_too_large'),
    }),
    async (context) => {
      const session = owner(context, services.secureCookie, false);
      const id = z.uuid().safeParse(context.req.param('id'));
      if (!session || !id.success) return apiError(context, 'not_found');
      const body = z
        .object({ archived: z.boolean() })
        .safeParse(await context.req.json().catch(() => null));
      if (!body.success) return apiError(context, 'invalid_input');
      const result = services.conversations.setArchived(
        session,
        id.data,
        body.data.archived,
      );
      return result === 'ok'
        ? context.body(null, 204)
        : apiError(context, result);
    },
  );
  app.delete('/conversations/:id', (context) => {
    const session = owner(context, services.secureCookie, false);
    const id = z.uuid().safeParse(context.req.param('id'));
    if (!session || !id.success) return apiError(context, 'not_found');
    const result = services.conversations.remove(session, id.data);
    return result === 'ok'
      ? context.body(null, 204)
      : apiError(context, result);
  });
  app.get('/conversations/:id', (context) => {
    const session = owner(context, services.secureCookie, false);
    const id = z.uuid().safeParse(context.req.param('id'));
    const conversation =
      session && id.success
        ? services.conversations.get(session, id.data)
        : undefined;
    return conversation
      ? context.json(conversation)
      : apiError(context, 'not_found');
  });
  app.get('/market/:symbol', async (context) => {
    const symbol = symbolSchema.safeParse(context.req.param('symbol'));
    const range = MarketRangeSchema.safeParse(context.req.query('range'));
    if (!symbol.success || !range.success)
      return apiError(context, 'invalid_input');
    if (!owner(context, services.secureCookie, false))
      return apiError(context, 'not_found');
    const limit = await services.rate.check(await services.ip(context));
    if (!limit.allowed) {
      context.header('Retry-After', String(limit.retryAfterSeconds));
      return apiError(context, 'rate_limit');
    }
    try {
      if (!services.market?.enabled) throw new MarketDataError('unconfigured');
      return context.json({
        points: await services.market.series(
          symbol.data,
          range.data,
          context.req.raw.signal,
        ),
      });
    } catch (error) {
      const code =
        error instanceof MarketDataError ? error.code : 'unavailable';
      const status =
        code === 'rate_limit'
          ? 429
          : code === 'not_found'
            ? 404
            : code === 'timeout'
              ? 504
              : 503;
      return context.json(
        {
          error: { code: 'market_' + code, message: marketErrorMessage(error) },
          requestId: context.get('requestId'),
        },
        status,
      );
    }
  });
  app.get('/quota', (context) =>
    context.json({ quotas: services.quota.snapshot() }),
  );
  app.get('/trace/:requestId', (context) => {
    const session = owner(context, services.secureCookie, false);
    const requestId = context.req.param('requestId');
    const events = session
      ? services.traces.read(session, requestId)
      : undefined;
    return events
      ? context.json({ requestId, events })
      : apiError(context, 'not_found');
  });

  let activePdfReads = 0;
  app.post(
    '/attachments/pdf',
    bodyLimit({
      maxSize: 5 * 1024 * 1024,
      onError: (context) => apiError(context, 'body_too_large'),
    }),
    async (context) => {
      const limit = await services.rate.check(await services.ip(context));
      if (!limit.allowed) {
        context.header('Retry-After', String(limit.retryAfterSeconds));
        return apiError(context, 'rate_limit');
      }
      if (activePdfReads >= 2) return apiError(context, 'unavailable');
      activePdfReads++;
      try {
        const data = new Uint8Array(await context.req.arrayBuffer());
        if (Buffer.from(data.subarray(0, 5)).toString('ascii') !== '%PDF-')
          return apiError(context, 'invalid_input');
        const { text } = await extractInWorker(
          { kind: 'pdf', data, maxPages: 12, maxTextChars: 6000 },
          AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(4500)]),
        );
        if (!text)
          return context.json(
            { error: { message: 'No readable text was found in this PDF.' } },
            422,
          );
        return context.json({ text });
      } catch {
        return context.json(
          {
            error: {
              message:
                'Could not read this PDF. Check that it opens and has selectable text.',
            },
          },
          422,
        );
      } finally {
        activePdfReads--;
      }
    },
  );

  app.post(
    '/chat',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) => apiError(context, 'body_too_large'),
    }),
    async (context) => {
      let input: unknown;
      try {
        input = await context.req.json();
      } catch {
        return apiError(context, 'invalid_input');
      }
      const parsed = chatBody.safeParse(input);
      if (!parsed.success) return apiError(context, 'invalid_input');

      const limit = await services.rate.check(await services.ip(context));
      if (!limit.allowed) {
        context.header('Retry-After', String(limit.retryAfterSeconds));
        return apiError(context, 'rate_limit');
      }

      const session = owner(context, services.secureCookie, true)!;
      const requestId = context.get('requestId');
      const { message, conversationId, webSearch, attachments } = parsed.data;
      const visibility =
        webSearch === 'off' && !parsed.data.allowHostedWithoutWeb
          ? 'private'
          : parsed.data.visibility;
      const history = services.conversations.start(
        session,
        conversationId,
        requestId,
        message,
      );
      if (!history.ok) return apiError(context, history.error);
      const id = history.conversationId;
      const captureReplay =
        visibility === 'public' &&
        attachments.length === 0 &&
        services.captureReplay === true;
      services.traces.begin(session, requestId, visibility, captureReplay);
      context.header('X-Conversation-Id', id);
      context.header('X-Accel-Buffering', 'no');

      const response = streamSSE(context, (stream) =>
        withTrace(
          {
            requestId,
            tracer,
            ...(captureReplay
              ? {
                  capture: (kind, value) =>
                    services.traces.artifact(requestId, kind, value),
                }
              : {}),
          },
          async () => {
            const started = performance.now();
            const controller = new AbortController();
            const abort = () => controller.abort();
            const requestSignal = context.req.raw.signal;
            requestSignal.addEventListener('abort', abort, { once: true });
            if (requestSignal.aborted) abort();
            stream.onAbort(abort);
            let writing = Promise.resolve();
            const enqueue = (write: () => Promise<unknown>) => {
              writing = writing
                .then(async () => {
                  if (!controller.signal.aborted) await write();
                })
                .catch(abort);
              return writing;
            };
            const send = (event: StreamEvent) =>
              enqueue(() =>
                stream.writeSSE({
                  event: event.type,
                  data: JSON.stringify(event),
                }),
              );
            const heartbeat = setInterval(
              () => void enqueue(() => stream.write(': keepalive\n\n')),
              5000,
            );
            const unsubscribe = services.traces.subscribe(
              requestId,
              (event) => {
                void send({ type: 'step', event });
              },
            );
            let sources: Passage[] = [];
            let saved = false;
            try {
              if (controller.signal.aborted) return;
              for await (const raw of services.run({
                requestId,
                message,
                visibility,
                webSearch,
                attachments,
                history,
                signal: controller.signal,
              })) {
                if (controller.signal.aborted) break;
                const event = StreamEventSchema.parse(raw);
                if (event.type === 'step') {
                  tracer.emit(event.event, true);
                  await writing;
                  continue;
                }
                if (event.type === 'sources') sources = event.passages;
                if (event.type === 'done') {
                  if (event.answer) {
                    saved = services.conversations.save(
                      session,
                      id,
                      requestId,
                      message,
                      visibility,
                      event.answer,
                      sources,
                    );
                    if (!saved) throw new Error('Conversation lease expired');
                  }
                  await send({ ...event, requestId });
                  return;
                }
                await send(event);
              }
              if (!controller.signal.aborted)
                throw new Error('The pipeline ended without a terminal event');
            } catch {
              if (!controller.signal.aborted) {
                await send({
                  type: 'error',
                  code: 'unavailable',
                  message: errors.unavailable.message,
                });
                await send({ type: 'done', requestId });
              }
            } finally {
              clearInterval(heartbeat);
              unsubscribe();
              requestSignal.removeEventListener('abort', abort);
              let cleanupFailed = false;
              try {
                if (!saved)
                  services.conversations.cancel(session, id, requestId);
              } catch {
                cleanupFailed = true;
              }
              tracer.emit({
                requestId,
                stage: 'http',
                type: 'chat_finished',
                ts: new Date().toISOString(),
                durationMs: performance.now() - started,
                attrs: {
                  saved,
                  disconnected: controller.signal.aborted,
                  cleanupFailed,
                },
              });
            }
          },
        ),
      );
      context.header('Cache-Control', 'no-store');
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
  );
  return app;
}
