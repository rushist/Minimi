import { defaults } from '../config/index.js';
import { waitFor } from '../resilience/wait-for.js';
import {
  parsePageUrl,
  resolveAddress,
  systemResolver,
  undiciTransport,
} from './network.js';
import { extractInWorker } from './worker.js';
import {
  ExtractedPageSchema,
  FetchFailure,
  FetchInputSchema,
  type ExtractedPage,
  type FetchOutcome,
  type HtmlRenderer,
  type PageTransport,
  type Resolver,
} from './types.js';

export type { ExtractedPage, FetchOutcome } from './types.js';

export interface FetchPolicy {
  timeoutMs: number;
  extractionTimeoutMs?: number;
  maxBytes: number;
  maxRedirects: number;
  negativeTtlMs: number;
  cacheEntries: number;
  maxTextChars: number;
  maxPdfPages?: number;
  browserEnabled?: boolean;
}

interface Dependencies {
  resolve?: Resolver;
  transport?: PageTransport;
  now?: () => number;
  render?: HtmlRenderer;
  extract?: typeof extractInWorker;
}

export const pageFetchPolicy = {
  timeoutMs: defaults.research.fetchTimeoutMs,
  extractionTimeoutMs: 8000,
  maxBytes: 2_000_000,
  maxRedirects: 4,
  negativeTtlMs: defaults.cacheTtlSeconds.negative * 1000,
  cacheEntries: 128,
  maxTextChars: 100_000,
  maxPdfPages: 40,
} as const;

interface CachedPage {
  page: ExtractedPage;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

type Negative = { error: 'timeout' | 'paywall' | 'forbidden'; expires: number };
type Entry = { positive: CachedPage } | { negative: Negative };

interface Flight {
  controller: AbortController;
  promise: Promise<FetchOutcome>;
  subscribers: number;
}

const redirects = new Set([301, 302, 303, 307, 308]);
const contentTypes = new Map<string, ExtractedPage['kind']>([
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'text'],
]);

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function readBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
) {
  let length = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    signal.throwIfAborted();
    length += chunk.length;
    if (length > maxBytes) throw new FetchFailure('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function decodeText(bytes: Uint8Array, contentType: string) {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export function createPageFetcher(
  policy: FetchPolicy = pageFetchPolicy,
  dependencies: Dependencies = {},
) {
  const {
    resolve = systemResolver,
    transport = undiciTransport,
    now = Date.now,
    render,
    extract = extractInWorker,
  } = dependencies;
  const cache = new Map<string, Entry>();
  const flights = new Map<string, Flight>();

  function remember(key: string, entry: Entry) {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > policy.cacheEntries)
      cache.delete(cache.keys().next().value!);
  }

  async function fetchPage(
    initial: URL,
    previous: CachedPage | undefined,
    controller: AbortController,
  ): Promise<FetchOutcome> {
    let timeout = AbortSignal.timeout(policy.timeoutMs);
    let signal = AbortSignal.any([controller.signal, timeout]);
    let url = initial;
    try {
      for (let hops = 0; ; hops++) {
        signal.throwIfAborted();
        const pinned = await resolveAddress(url, resolve, signal);
        const cached = previous?.page.url === url.href ? previous : undefined;
        const headers: Record<string, string> = {
          accept:
            'text/html, application/xhtml+xml, application/pdf, text/plain',
          'user-agent': 'EvidenceSearch/0.1',
        };
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        if (cached?.lastModified)
          headers['if-modified-since'] = cached.lastModified;

        const response = await transport.open(url, pinned, headers, signal);
        try {
          if (redirects.has(response.status)) {
            if (hops >= policy.maxRedirects)
              throw new FetchFailure('redirect_limit');
            const location = header(response.headers, 'location');
            if (!location) throw new FetchFailure('http_error');
            url = parsePageUrl(location, url);
            continue;
          }
          if (
            response.status === 304 &&
            cached &&
            (cached.etag || cached.lastModified)
          ) {
            const updated = {
              page: {
                ...cached.page,
                retrievedAt: new Date(now()).toISOString(),
              },
              etag: header(response.headers, 'etag') ?? cached.etag,
              lastModified:
                header(response.headers, 'last-modified') ??
                cached.lastModified,
            };
            remember(initial.href, { positive: updated });
            return { ok: true, page: updated.page, revalidated: true };
          }
          if (response.status === 403) throw new FetchFailure('forbidden');
          if (response.status === 402) throw new FetchFailure('paywall');
          if (
            response.status < 200 ||
            response.status >= 300 ||
            response.status === 206
          )
            throw new FetchFailure('http_error');
          const contentType = header(response.headers, 'content-type') ?? '';
          const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
          const kind = contentTypes.get(mediaType);
          const encoding = header(response.headers, 'content-encoding');
          if (!kind || (encoding && encoding.toLowerCase() !== 'identity'))
            throw new FetchFailure('unsupported_type');
          const declared = Number(header(response.headers, 'content-length'));
          if (declared > policy.maxBytes) throw new FetchFailure('too_large');
          const bytes = await readBody(response.body, policy.maxBytes, signal);

          signal.throwIfAborted();
          timeout = AbortSignal.timeout(
            policy.extractionTimeoutMs ?? pageFetchPolicy.extractionTimeoutMs,
          );
          signal = AbortSignal.any([controller.signal, timeout]);
          let extracted;
          try {
            if (kind === 'pdf') {
              extracted = await extract(
                {
                  kind: 'pdf',
                  data: bytes,
                  maxPages: policy.maxPdfPages ?? pageFetchPolicy.maxPdfPages,
                  maxTextChars: policy.maxTextChars,
                },
                signal,
              );
            } else if (kind === 'html') {
              extracted = await extract(
                { kind: 'html', data: bytes, url: url.href, contentType },
                signal,
              );
              if (!extracted.text && policy.browserEnabled && render) {
                const rendered = await render(
                  decodeText(bytes, contentType),
                  signal,
                );
                extracted = await extract(
                  {
                    kind: 'html',
                    data: rendered,
                    url: url.href,
                    contentType: 'text/html',
                  },
                  signal,
                );
              }
            } else {
              extracted = { title: '', text: decodeText(bytes, contentType) };
            }
          } catch (cause) {
            if (cause instanceof FetchFailure) throw cause;
            throw new FetchFailure('extraction_failed');
          }
          signal.throwIfAborted();
          const page = ExtractedPageSchema.safeParse({
            url: url.href,
            kind,
            title: extracted.title.slice(0, 1000),
            text: extracted.text
              .replaceAll('\0', '')
              .slice(0, policy.maxTextChars),
            retrievedAt: new Date(now()).toISOString(),
          });
          if (!page.success) throw new FetchFailure('extraction_failed');
          remember(initial.href, {
            positive: {
              page: page.data,
              etag: header(response.headers, 'etag'),
              lastModified: header(response.headers, 'last-modified'),
            },
          });
          return { ok: true, page: page.data, revalidated: false };
        } finally {
          await response.dispose().catch(() => {});
        }
      }
    } catch (cause) {
      const error = controller.signal.aborted
        ? 'aborted'
        : timeout.aborted
          ? 'timeout'
          : cause instanceof FetchFailure
            ? cause.code
            : 'network_error';
      if (error === 'timeout' || error === 'paywall' || error === 'forbidden') {
        remember(initial.href, {
          negative: { error, expires: now() + policy.negativeTtlMs },
        });
      }
      return { ok: false, error };
    }
  }

  return async function getPage(
    input: string,
    signal?: AbortSignal,
  ): Promise<FetchOutcome> {
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    const parsed = FetchInputSchema.safeParse({ url: input });
    if (!parsed.success) return { ok: false, error: 'invalid_url' };
    let url: URL;
    try {
      url = parsePageUrl(parsed.data.url);
    } catch {
      return { ok: false, error: 'invalid_url' };
    }

    const key = url.href;
    const entry = cache.get(key);
    if (entry && 'negative' in entry) {
      if (entry.negative.expires > now())
        return { ok: false, error: entry.negative.error };
      cache.delete(key);
    }
    let flight = flights.get(key);
    if (!flight) {
      const previous =
        entry && 'positive' in entry ? entry.positive : undefined;
      const controller = new AbortController();
      const promise = fetchPage(url, previous, controller).finally(() => {
        if (flights.get(key)?.controller === controller) flights.delete(key);
      });
      flight = { controller, promise, subscribers: 0 };
      flights.set(key, flight);
    }
    flight.subscribers++;
    try {
      return await (signal ? waitFor(flight.promise, signal) : flight.promise);
    } catch {
      return { ok: false, error: 'aborted' };
    } finally {
      if (--flight.subscribers === 0 && flights.get(key) === flight) {
        flights.delete(key);
        flight.controller.abort();
      }
    }
  };
}
