import { describe, expect, it, vi } from 'vitest';
import { createMarketData, cryptoQuoteQuery, quoteQuery } from './index.js';

describe('stock market data', () => {
  it('routes direct requests without intercepting stock news', () => {
    expect(quoteQuery('nvidia stock prices')).toBe('NVDA');
    expect(quoteQuery('nvidiia stock price')).toBe('NVDA');
    expect(quoteQuery('nvidia stock price current')).toBe('NVDA');
    expect(quoteQuery('stock price for NVDA latest')).toBe('NVDA');
    expect(quoteQuery('What is the current stock price of NVDA?')).toBe('NVDA');
    expect(quoteQuery('How much is NVIDIA trading at right now?')).toBe('NVDA');
    expect(
      quoteQuery(
        'What is the latest price of Nvidia (NVDA)? Include the timestamp.',
      ),
    ).toBe('NVDA');
    expect(quoteQuery('Why did Nvidia stock fall today?')).toBeUndefined();
  });

  it('uses the quote timestamp and coalesces duplicate requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        symbol: 'NVDA',
        name: 'NVIDIA',
        exchange: 'NASDAQ',
        currency: 'USD',
        close: '150.25',
        timestamp: 1760000000,
        last_quote_at: 1760000060,
        is_market_open: false,
      }),
    );
    const feed = createMarketData('test-key', fetcher, () => 1760000600000);
    const results = await Promise.all([feed.quote('NVDA'), feed.quote('NVDA')]);
    expect(results[0]).toMatchObject({
      price: 150.25,
      timestamp: new Date(1760000060000).toISOString(),
      marketOpen: false,
    });
    expect(results[1]).toEqual(results[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('test-key');
  });

  it('rejects a stale quote even if the provider returns it successfully', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        symbol: 'NVDA',
        name: 'NVIDIA',
        exchange: 'NASDAQ',
        currency: 'USD',
        close: '210.16',
        timestamp: Date.parse('2026-08-26T20:00:00Z') / 1000,
      }),
    );
    const feed = createMarketData('test-key', fetcher, () =>
      Date.parse('2026-11-14T05:30:00+05:30'),
    );
    await expect(feed.quote('NVDA')).rejects.toMatchObject({
      code: 'stale_quote',
    });
  });

  it('orders chart points and rejects an upstream error response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          values: [
            { datetime: '2026-11-12 15:05:00', close: '152' },
            { datetime: '2026-11-12 15:00:00', close: '151' },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'error' }));
    const feed = createMarketData('test-key', fetcher);
    expect((await feed.series('NVDA', '1d')).map((point) => point[1])).toEqual([
      151, 152,
    ]);
    await expect(feed.series('NVDA', 'all')).rejects.toThrow(
      'Market data is unavailable',
    );
  });

  it('distinguishes rejected credentials, plan restrictions, and rate limits', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: 'error', code: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const feed = createMarketData('test-key', fetcher);
    await expect(feed.quote('NVDA')).rejects.toMatchObject({
      code: 'authentication',
    });
    await expect(feed.quote('NVDA')).rejects.toMatchObject({
      code: 'permission',
    });
    await expect(feed.quote('NVDA')).rejects.toMatchObject({
      code: 'rate_limit',
    });
  });

  it('fetches an exchange timestamp for a direct crypto quote without a stock key', async () => {
    const request =
      'What is the latest BTC/USD price? Include the exchange, timestamp and timezone.';
    const pair = cryptoQuoteQuery(request);
    expect(pair).toBe('BTC-USD');
    expect(
      cryptoQuoteQuery('What is the BTC/USD price trend?'),
    ).toBeUndefined();
    expect(cryptoQuoteQuery('What is the Bitcoin price?')).toBe('BTC-USD');
    expect(cryptoQuoteQuery('What is the EUR/USD price?')).toBeUndefined();
    expect(
      cryptoQuoteQuery('What is the Bitcoin price? Explain why it rose.'),
    ).toBeUndefined();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ price: '65000', time: '2026-11-13T14:59:03.010Z' }),
      )
      .mockResolvedValueOnce(Response.json({ price: '65000' }));
    const feed = createMarketData(undefined, fetcher);
    const quote = await feed.cryptoQuote(pair!);
    expect(quote).toEqual({
      pair,
      exchange: 'Coinbase Exchange',
      currency: 'USD',
      price: 65000,
      timestamp: '2026-11-13T14:59:03.010Z',
      sourceUrl: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(quote.sourceUrl);
    await expect(feed.cryptoQuote(pair!)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
