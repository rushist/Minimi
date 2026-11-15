import { z } from 'zod';
import type { MarketQuote, MarketRange } from '@chatagent/shared';
import { waitFor } from '../resilience/wait-for.js';

export const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/);
const aliases: Record<string, string> = {
  nvidia: 'NVDA',
  apple: 'AAPL',
  microsoft: 'MSFT',
  tesla: 'TSLA',
  amazon: 'AMZN',
  alphabet: 'GOOGL',
  google: 'GOOGL',
  meta: 'META',
};
export function quoteQuery(message: string): string | undefined {
  const query = (message.split(/(?<=[?!])\s/, 1)[0] ?? '')
    .trim()
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ');
  const match =
    /^(?:what(?: is|['’]s) (?:the )?)?(?:current |latest |live |today['’]?s )?(?:(.+?)(?:['’]s)? (?:stock(?: price(?:s)?)?|share price|quote|price chart)|(?:stock price|share price|quote|price chart) (?:for|of) (.+?))(?: (?:right now|today|now|current|latest|live))?$/i.exec(
      query,
    );
  const trading =
    /^(?:(?:what is|what['’]s|how much is)\s+)?(.+?)\s+(?:(?:currently\s+)?trading at|trading for)\s*(?:right now|today|now)?$/i.exec(
      query,
    );
  const short =
    /^(?:what(?: is|['’]s) (?:the )?)?(?:current |latest |live )?(?:price (?:of|for) (.+?)|(.+?)(?:['’]s)? price)(?: (?:right now|today|now))?$/i.exec(
      query,
    );
  const name = (
    match?.[1] ??
    match?.[2] ??
    trading?.[1] ??
    short?.[1] ??
    short?.[2]
  )
    ?.replace(/\s+stock$/i, '')
    .trim();
  if (!name) return;
  const ticker = (
    name.match(/\(\$?([A-Z][A-Z0-9.-]{0,11})\)$/)?.[1] ??
    name.replace(/^\$/, '')
  ).toUpperCase();
  const alias = ticker.toLowerCase();
  const deduplicated = alias.replace(/([a-z])\1+/g, '$1');
  return Object.hasOwn(aliases, ticker.toLowerCase())
    ? aliases[alias]
    : Object.hasOwn(aliases, deduplicated)
      ? aliases[deduplicated]
      : match ||
          trading ||
          name === name.toUpperCase() ||
          /\([A-Z0-9.-]+\)$/.test(name)
        ? symbolSchema.safeParse(ticker).data
        : undefined;
}

export function needsCurrentStockQuote(message: string) {
  return (
    /\b(?:current|latest|live|today['’]s)\s+(?:stock|share)\s+(?:price|quote)|\b(?:stock|share)\s+(?:price|quote)\b[^?!.]{0,100}\b(?:right now|today|now)\b/i.test(
      message,
    ) &&
    !/\b(?:why|target|prediction|forecast|historical|history)\b/i.test(message)
  );
}

const positive = z
  .union([z.number(), z.string().trim().min(1)])
  .pipe(z.coerce.number<string | number>().positive());
const cryptoPairSchema = z.string().regex(/^[A-Z0-9]{2,10}-[A-Z]{3}$/);
const cryptoAliases: Record<string, string> = {
  bitcoin: 'BTC',
  ether: 'ETH',
  ethereum: 'ETH',
  solana: 'SOL',
};
const fiatCodes = new Set([
  'AUD',
  'CAD',
  'CHF',
  'CNY',
  'EUR',
  'GBP',
  'HKD',
  'INR',
  'JPY',
  'MXN',
  'NZD',
  'SGD',
  'USD',
  'ZAR',
]);

export function cryptoQuoteQuery(message: string) {
  const [first, ...rest] = message.split(/(?<=[?!])\s|\.(?=\s|$)/u);
  const details = rest
    .join(' ')
    .trim()
    .replace(/[.?!]+$/, '');
  if (
    details &&
    !/^(?:include|give|provide|state) (?:the )?(?:(?:exchange|trade timestamp|timestamp|timezone|time zone|source)(?:,?\s+(?:and\s+)?|$))+$/i.test(
      details,
    )
  )
    return;
  const request = first?.trim() ?? '';
  const match =
    /^(?:what(?: is|['’]s) (?:the )?)?(?:(?:current|latest|live|today['’]?s) )?(?:price (?:for|of) )?(?:(?<asset>[a-z0-9]{2,10})\s*[/–-]\s*(?<currency>usd|eur|gbp)|(?<name>bitcoin|ether|ethereum|solana))(?: (?:price|quote))?(?: (?:right now|today|now))?[?!]?$/i.exec(
      request,
    )?.groups;
  if (!match || (!match.asset && !/\b(?:price|quote)\b/i.test(request))) return;
  const asset =
    match.asset?.toUpperCase() ?? cryptoAliases[match.name!.toLowerCase()];
  if (!asset || fiatCodes.has(asset)) return;
  return cryptoPairSchema.safeParse(
    asset + '-' + (match.currency ?? 'USD').toUpperCase(),
  ).data;
}

const marketErrors = {
  unconfigured: 'The stock quote feed needs a Twelve Data API key.',
  authentication:
    'Twelve Data rejected authentication. Check the configured Twelve Data API key.',
  permission: 'Twelve Data does not allow this request on the configured plan.',
  rate_limit:
    'The market data provider is rate limiting requests. Try again after its limit resets.',
  not_found: 'The market data provider has no quote for that symbol or pair.',
  timeout: 'The market data request timed out. Try again.',
  invalid_response:
    'The market data provider did not return a valid timestamped result.',
  stale_quote:
    'The market data feed did not return a recent quote. The price is unavailable.',
  unavailable: 'Market data is unavailable.',
} as const;

export class MarketDataError extends Error {
  constructor(readonly code: keyof typeof marketErrors) {
    super(marketErrors[code]);
  }
}

export function marketErrorMessage(error: unknown) {
  return error instanceof MarketDataError
    ? error.message
    : marketErrors.unavailable;
}

function providerError(status: number, stock: boolean) {
  if (stock && status === 401) return new MarketDataError('authentication');
  if (stock && status === 403) return new MarketDataError('permission');
  if (status === 429) return new MarketDataError('rate_limit');
  if (status === 404) return new MarketDataError('not_found');
  if (status === 408 || status === 504) return new MarketDataError('timeout');
  return new MarketDataError('unavailable');
}

const quoteSchema = z.object({
  symbol: symbolSchema,
  name: z.string(),
  exchange: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  close: positive,
  timestamp: z.number().int().positive(),
  last_quote_at: z.number().int().positive().nullish(),
  is_market_open: z.boolean().optional(),
});
const seriesSchema = z.object({
  values: z
    .array(z.object({ datetime: z.string(), close: positive }))
    .max(5000),
});
const cryptoQuoteSchema = z.object({
  price: positive,
  time: z.iso.datetime({ offset: true }),
});
const errorSchema = z.object({
  status: z.literal('error'),
  code: z.coerce.number().optional(),
});
const ranges = {
  '1d': ['5min', 78, 0],
  '1w': ['30min', 100, 7],
  '1m': ['1day', 32, 31],
  '1y': ['1day', 366, 365],
  '5y': ['1week', 270, 1827],
  all: ['1month', 5000, 0],
} as const;

export function createMarketData(
  key: string | undefined,
  fetcher = fetch,
  now = Date.now,
) {
  const cache = new Map<string, { expires: number; data: Promise<unknown> }>();
  const apiKey = key?.trim();
  async function fetchJson(
    url: URL,
    headers?: HeadersInit,
    parent?: AbortSignal,
  ) {
    const deadline = AbortSignal.timeout(4500);
    const signal = parent ? AbortSignal.any([deadline, parent]) : deadline;
    try {
      const response = await fetcher(url, {
        ...(headers ? { headers } : {}),
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw providerError(response.status, Boolean(headers));
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      if (deadline.aborted) throw new MarketDataError('timeout');
      parent?.throwIfAborted();
      if (error instanceof SyntaxError)
        throw new MarketDataError('invalid_response');
      throw new MarketDataError('unavailable');
    }
  }

  async function request(
    path: 'quote' | 'time_series',
    params: Record<string, string>,
  ) {
    if (!apiKey) throw new MarketDataError('unconfigured');
    const url = new URL('https://api.twelvedata.com/' + path);
    url.search = new URLSearchParams(params).toString();
    const id = url.href;
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.data;
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    const data = (async () => {
      const body = await fetchJson(url, { Authorization: 'apikey ' + apiKey });
      const error = errorSchema.safeParse(body);
      if (error.success) throw providerError(error.data.code ?? 500, true);
      return body;
    })();
    cache.set(id, {
      expires: Date.now() + (path === 'quote' ? 15000 : 60000),
      data,
    });
    try {
      return await data;
    } catch (error) {
      if (cache.get(id)?.data === data) cache.delete(id);
      throw error;
    }
  }
  return {
    enabled: Boolean(apiKey),
    async quote(symbol: string, signal?: AbortSignal): Promise<MarketQuote> {
      signal?.throwIfAborted();
      const requestQuote = request('quote', { symbol });
      const result = quoteSchema.safeParse(
        await (signal ? waitFor(requestQuote, signal) : requestQuote),
      );
      if (!result.success || result.data.symbol !== symbol)
        throw new MarketDataError('invalid_response');
      const data = result.data;
      const timestamp = new Date((data.last_quote_at ?? data.timestamp) * 1000);
      if (!Number.isFinite(timestamp.getTime()))
        throw new MarketDataError('invalid_response');
      // Reject stale data while allowing a recent close across weekends and holidays.
      const age = now() - timestamp.getTime();
      if (age < -5 * 60_000 || age > 5 * 86_400_000)
        throw new MarketDataError('stale_quote');
      return {
        symbol,
        name: data.name,
        exchange: data.exchange,
        currency: data.currency,
        price: data.close,
        timestamp: timestamp.toISOString(),
        ...(data.is_market_open === undefined
          ? {}
          : { marketOpen: data.is_market_open }),
      };
    },
    async cryptoQuote(pair: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!cryptoPairSchema.safeParse(pair).success)
        throw new MarketDataError('not_found');
      const sourceUrl =
        'https://api.exchange.coinbase.com/products/' + pair + '/ticker';
      const result = cryptoQuoteSchema.safeParse(
        await fetchJson(new URL(sourceUrl), undefined, signal),
      );
      if (!result.success) throw new MarketDataError('invalid_response');
      return {
        pair,
        exchange: 'Coinbase Exchange',
        currency: pair.slice(-3),
        price: result.data.price,
        timestamp: new Date(result.data.time).toISOString(),
        sourceUrl,
      };
    },
    async series(symbol: string, range: MarketRange, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const [interval, size, days] = ranges[range];
      const start = days
        ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
        : undefined;
      const work = request('time_series', {
        symbol,
        interval,
        outputsize: String(size),
        timezone: 'UTC',
        ...(start ? { start_date: start } : {}),
      });
      const result = seriesSchema.safeParse(
        await (signal ? waitFor(work, signal) : work),
      );
      if (!result.success) throw new MarketDataError('invalid_response');
      const data = result.data;
      const points = new Map<number, number>();
      for (const { datetime, close } of data.values) {
        const time = Date.parse(
          datetime.replace(' ', 'T') + (datetime.includes(' ') ? 'Z' : ''),
        );
        if (Number.isFinite(time)) points.set(time, close);
      }
      return [...points.entries()].sort(([a], [b]) => a - b);
    },
  };
}
export type MarketData = ReturnType<typeof createMarketData>;
