import { useEffect, useState } from 'react';
import type {
  MarketQuote,
  MarketRange,
} from '../../../packages/shared/src/index.js';

const ranges: MarketRange[] = ['1d', '1w', '1m', '1y', '5y', 'all'];
type Point = [number, number];
export default function MarketCard({ quote }: { quote: MarketQuote }) {
  const [range, setRange] = useState<MarketRange>('1d');
  const [result, setResult] = useState<{
    range: MarketRange;
    points: Point[] | null;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      '/api/market/' + encodeURIComponent(quote.symbol) + '?range=' + range,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(
            payload?.error?.message ?? 'Chart data unavailable for this range.',
          );
        }
        return (await response.json()) as { points: Point[] };
      })
      .then(({ points }) => setResult({ range, points }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            range,
            points: null,
            error:
              error instanceof Error
                ? error.message
                : 'Chart data unavailable for this range.',
          });
        }
      });
    return () => controller.abort();
  }, [quote.symbol, range]);
  const points = result?.range === range ? result.points : undefined;
  const values = points?.map((point) => point[1]) ?? [];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const line = points
    ?.map(([, price], i) => {
      const x = 5 + (i / Math.max(points.length - 1, 1)) * 590;
      const y = high === low ? 80 : 150 - ((price - low) / (high - low)) * 140;
      return x.toFixed(2) + ',' + y.toFixed(2);
    })
    .join(' ');
  const money = (price: number) =>
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: quote.currency,
    }).format(price);
  return (
    <section className="market-card" aria-label={quote.symbol + ' market data'}>
      <div>
        {quote.name} · {quote.exchange}: {quote.symbol}
      </div>
      <strong className="market-price">
        {money(quote.price)} <small>{quote.currency}</small>
      </strong>
      <div className="market-meta">
        Last reported{' '}
        {new Date(quote.timestamp).toLocaleString('en-IN', {
          dateStyle: 'medium',
          timeStyle: 'medium',
          timeZone: 'Asia/Kolkata',
        })}{' '}
        IST ·{' '}
        {quote.marketOpen === undefined
          ? 'Regular-session feed'
          : quote.marketOpen
            ? 'Market open'
            : 'Market closed'}{' '}
        · Data may be delayed
      </div>
      <div className="market-ranges" role="group" aria-label="Chart range">
        {ranges.map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={range === value}
            onClick={() => setRange(value)}
          >
            {value === 'all' ? 'All' : value.toUpperCase()}
          </button>
        ))}
      </div>
      {points === undefined ? (
        <p role="status">Loading chart…</p>
      ) : !points || points.length < 2 ? (
        <p>{result?.error ?? 'Chart data unavailable for this range.'}</p>
      ) : (
        <>
          <svg
            viewBox="0 0 600 160"
            role="img"
            aria-label={
              range +
              ' price history, low ' +
              money(low) +
              ', high ' +
              money(high)
            }
          >
            <polyline
              points={line}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="market-axis">
            <span>{new Date(points[0]![0]).toLocaleDateString()}</span>
            <span>{new Date(points.at(-1)![0]).toLocaleDateString()}</span>
          </div>
        </>
      )}
      <a href="https://twelvedata.com/" target="_blank" rel="noreferrer">
        Market data by Twelve Data
      </a>
    </section>
  );
}
