import { SearchSpecSchema, type SearchSpec } from '@chatagent/shared';
import { z } from 'zod';
import { searchPolicy } from '../config/search.js';
import { dateBounds, normalizeResults, quotedQuery } from './results.js';
import {
  SearchFailure,
  type SearchProvider,
  type SearchRequest,
  type SearchTransport,
} from './types.js';

const date = z.string().nullish();
const baseResult = z.object({ url: z.string(), title: z.string().nullish() });
const tavilyResponse = z.object({
  results: z.array(
    baseResult.extend({ content: z.string().nullish(), published_date: date }),
  ),
});
const exaResponse = z.object({
  results: z.array(
    baseResult.extend({
      highlights: z.array(z.string()).nullish(),
      publishedDate: date,
    }),
  ),
});
const searxResponse = z.object({
  results: z.array(
    baseResult.extend({
      content: z.string().nullish(),
      publishedDate: date,
      published_date: date,
    }),
  ),
});

function adapter<S extends z.ZodType>(
  name: string,
  transport: SearchTransport,
  schema: S,
  request: (spec: SearchSpec, now: Date) => Omit<SearchRequest, 'provider'>,
  normalize: (body: z.output<S>) => Parameters<typeof normalizeResults>[3],
  clock: () => Date,
): SearchProvider {
  return {
    name,
    async search(input, signal) {
      const parsed = SearchSpecSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'invalid_spec' };
      const spec = parsed.data;
      const timeout = AbortSignal.timeout(searchPolicy.adapterTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const now = clock();
      try {
        combined.throwIfAborted();
        const response = await transport.send(
          { ...request(spec, now), provider: name },
          combined,
        );
        combined.throwIfAborted();
        if (response.status === 429 || response.status === 432) {
          const header = response.retryAfter;
          const delay =
            header && /^\d+$/.test(header)
              ? Number(header) * 1000
              : header
                ? Date.parse(header) - now.getTime()
                : NaN;
          return {
            ok: false,
            error: 'rate_limit',
            ...(Number.isFinite(delay)
              ? { retryAfterMs: Math.max(0, delay) }
              : {}),
          };
        }
        if (response.status < 200 || response.status >= 300)
          return {
            ok: false,
            error:
              response.status >= 500 || response.status === 408
                ? 'unavailable'
                : 'rejected',
          };
        const body = schema.safeParse(response.body);
        if (!body.success) return { ok: false, error: 'invalid_response' };
        return {
          ok: true,
          results: normalizeResults(name, spec, now, normalize(body.data)),
        };
      } catch (cause) {
        if (signal?.aborted) return { ok: false, error: 'aborted' };
        if (timeout.aborted) return { ok: false, error: 'timeout' };
        return {
          ok: false,
          error: cause instanceof SearchFailure ? cause.code : 'unavailable',
        };
      }
    },
  };
}

const systemClock = () => new Date();

export function tavily(
  key: string,
  transport: SearchTransport,
  clock = systemClock,
): SearchProvider {
  return adapter(
    'tavily',
    transport,
    tavilyResponse,
    (spec) => ({
      url: 'https://api.tavily.com/search',
      headers: { Authorization: 'Bearer ' + key },
      body: {
        query: quotedQuery(spec),
        topic: spec.topic,
        search_depth: 'basic',
        max_results: 5,
        auto_parameters: false,
        include_published_date: true,
        filter_by_published_date: Boolean(spec.recency || spec.dateRange),
        include_domains: spec.includeDomains,
        exclude_domains: spec.excludeDomains,
        ...(spec.recency ? { time_range: spec.recency } : {}),
        ...(spec.dateRange
          ? { start_date: spec.dateRange.start, end_date: spec.dateRange.end }
          : {}),
      },
    }),
    ({ results }) =>
      results.map((row) => ({
        url: row.url,
        title: row.title ?? '',
        snippet: row.content ?? '',
        date: row.published_date,
      })),
    clock,
  );
}

export function exa(
  key: string,
  transport: SearchTransport,
  clock = systemClock,
): SearchProvider {
  return adapter(
    'exa',
    transport,
    exaResponse,
    (spec, now) => {
      const dates = dateBounds(spec, now);
      return {
        url: 'https://api.exa.ai/search',
        headers: { 'x-api-key': key },
        body: {
          query: quotedQuery(spec),
          type: 'lite',
          numResults: 5,
          contents: { highlights: true },
          ...(spec.topic === 'news' ? { category: 'news' } : {}),
          ...(spec.includeDomains.length
            ? { includeDomains: spec.includeDomains }
            : {}),
          ...(spec.excludeDomains.length
            ? { excludeDomains: spec.excludeDomains }
            : {}),
          ...(dates
            ? { startPublishedDate: dates.start, endPublishedDate: dates.end }
            : {}),
        },
      };
    },
    ({ results }) =>
      results.map((row) => ({
        url: row.url,
        title: row.title ?? '',
        snippet: row.highlights?.join('\n') ?? '',
        date: row.publishedDate,
      })),
    clock,
  );
}

export function searxng(
  baseUrl: string,
  transport: SearchTransport,
  clock = systemClock,
): SearchProvider {
  return adapter(
    'searxng',
    transport,
    searxResponse,
    (spec) => {
      const url = new URL(baseUrl.replace(/\/$/, '') + '/search');
      url.searchParams.set('q', quotedQuery(spec));
      url.searchParams.set('format', 'json');
      url.searchParams.set(
        'categories',
        spec.topic === 'news' ? 'news' : 'general',
      );
      if (spec.recency)
        url.searchParams.set(
          'time_range',
          spec.recency === 'week' ? 'month' : spec.recency,
        );
      return { url: url.href };
    },
    ({ results }) =>
      results.map((row) => ({
        url: row.url,
        title: row.title ?? '',
        snippet: row.content ?? '',
        date: row.publishedDate ?? row.published_date,
      })),
    clock,
  );
}
