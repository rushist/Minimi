import { createAnswerer } from '../answer/index.js';
import { createEvidenceCache } from '../cache/evidence.js';
import { openCacheStore } from '../cache/redis.js';
import { readChatEnv } from '../config/chat.js';
import { readRetrievalEnv } from '../config/retrieval.js';
import { readTraceEnv } from '../config/telemetry.js';
import { configurePageFetcher } from '../config/fetch.js';
import { configureQuota, readSearchEnv } from '../config/search.js';
import { createClientIp } from '../http/client-ip.js';
import { createRateLimiter } from '../http/rate-limit.js';
import { configureLLM } from '../llm/index.js';
import { createMarketData } from '../market/index.js';
import { createPlanner } from '../planner/index.js';
import { createResearcher } from '../researcher/index.js';
import { configureRetriever } from '../retrieval/index.js';
import { createLocalEmbedder } from '../retrieval/semantic.js';
import { configureSearch } from '../search/index.js';
import { openConversationStore } from '../store/conversations.js';
import { createRequestTraces } from '../telemetry/request-traces.js';
import { createRedactor } from '../telemetry/redact.js';
import { openTraceStore } from '../telemetry/sqlite.js';
import { createLangfuseSink } from '../telemetry/langfuse.js';
import type { Tracer } from '../telemetry/tracer.js';
import { createChatPipeline } from './pipeline.js';
import { createForecastData } from '../weather/index.js';

export function openChatRuntime(
  env: Record<string, string | undefined>,
  redisUrl: string,
  tracer: Tracer,
) {
  const chat = readChatEnv(env);
  const search = readSearchEnv(env);
  const redis = openCacheStore(redisUrl);
  const retrieval = readRetrievalEnv(env);
  const embedder = createLocalEmbedder(
    retrieval.RETRIEVAL_EMBEDDING_DIR,
    retrieval.RETRIEVAL_EMBEDDING_REVISION,
  );
  const evidence = createEvidenceCache(
    redis.store,
    Date.now,
    retrieval.SEMANTIC_SEARCH_CACHE_ENABLED === 'true' ? embedder : undefined,
  );
  const conversations = openConversationStore(chat.CHAT_DB_PATH);
  const quota = configureQuota(search);
  const traceConfig = readTraceEnv(env);
  const traceStore = openTraceStore(traceConfig.TRACE_DB_PATH);
  const redact = createRedactor(env);
  const remote =
    traceConfig.LANGFUSE_PUBLIC_KEY && traceConfig.LANGFUSE_SECRET_KEY
      ? createLangfuseSink(
          traceConfig.LANGFUSE_BASE_URL,
          traceConfig.LANGFUSE_PUBLIC_KEY,
          traceConfig.LANGFUSE_SECRET_KEY,
        )
      : undefined;
  const traces = createRequestTraces(Date.now, {
    store: traceStore,
    redact,
    ...(remote ? { remote: remote.push } : {}),
  });
  const llm = configureLLM(
    env,
    {
      emit(event) {
        tracer.emit(traces.record(event));
      },
    },
    quota.meter,
  );
  const plan = createPlanner(llm);
  const market = createMarketData(env.TWELVE_DATA_API_KEY?.trim());
  const research = createResearcher({
    search: configureSearch(search, quota.meter, evidence, redact),
    fetchPage: configurePageFetcher(env, evidence),
    retrieve: configureRetriever(env, evidence, embedder),
    llm,
    quota: quota.meter,
  });
  return {
    routes: {
      run: createChatPipeline({
        plan,
        research,
        answerer: createAnswerer(llm),
        llm,
        market,
        weather: createForecastData(),
      }),
      conversations: conversations.store,
      market,
      quota: quota.meter,
      traces,
      captureReplay: traceConfig.TRACE_REPLAY_ENABLED === 'true',
      rate: createRateLimiter(
        chat.CHAT_RATE_LIMIT,
        chat.CHAT_RATE_WINDOW_SECONDS,
        redis.client,
      ),
      ip: createClientIp(chat.CHAT_TRUSTED_PROXY_HOST),
      allowedOrigins: chat.CHAT_ALLOWED_ORIGINS,
      secureCookie: chat.CHAT_SECURE_COOKIE === 'true',
    },
    close() {
      remote?.close();
      traceStore.close();
      redis.close();
      conversations.close();
      quota.close();
    },
  };
}
