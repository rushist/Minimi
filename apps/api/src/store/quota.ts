import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type QuotaBucket = 'tavily' | 'exa' | 'groq' | 'gemini';
type QuotaLimits = Partial<Record<QuotaBucket, number>>;

export interface QuotaMeter {
  reserve(bucket: QuotaBucket, units?: number): boolean;
  snapshot(): {
    bucket: QuotaBucket;
    used: number;
    limit: number | null;
    period: string;
    nearLimit: boolean;
  }[];
}

const buckets = ['tavily', 'exa', 'groq', 'gemini'] as const;
function periodFor(bucket: QuotaBucket, now: Date): string {
  return now
    .toISOString()
    .slice(0, bucket === 'tavily' || bucket === 'exa' ? 7 : 10);
}

export function openQuotaMeter(
  path: string,
  limits: QuotaLimits,
  threshold: number,
  clock = () => new Date(),
) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_usage (
      bucket TEXT NOT NULL,
      period TEXT NOT NULL,
      used INTEGER NOT NULL,
      PRIMARY KEY (bucket, period)
    )
  `);
  const get = db.prepare<[QuotaBucket, string], { used: number }>(
    'SELECT used FROM quota_usage WHERE bucket = ? AND period = ?',
  );
  const reserve = db.prepare(`
    INSERT INTO quota_usage (bucket, period, used) VALUES (@bucket, @period, @units)
    ON CONFLICT (bucket, period) DO UPDATE SET used = used + @units
    WHERE used <= @limit - @units
  `);

  const meter: QuotaMeter = {
    reserve(bucket, units = 1) {
      const limit = limits[bucket] ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(units) || units < 1 || units > limit)
        return false;
      return (
        reserve.run({
          bucket,
          period: periodFor(bucket, clock()),
          units,
          limit,
        }).changes === 1
      );
    },
    snapshot() {
      const now = clock();
      return buckets.map((bucket) => {
        const period = periodFor(bucket, now);
        const used = get.get(bucket, period)?.used ?? 0;
        const limit = limits[bucket] ?? null;
        return {
          bucket,
          period,
          used,
          limit,
          nearLimit: limit !== null && used >= limit * threshold,
        };
      });
    },
  };
  return { meter, close: () => db.close() };
}
