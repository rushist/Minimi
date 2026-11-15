import {
  SearchResultSchema,
  type SearchResult,
  type SearchSpec,
} from '@chatagent/shared';

import { canonicalUrl, matchesSourceDomains } from '../url.js';

export function quotedQuery(spec: SearchSpec): string {
  return [
    spec.query,
    ...spec.exactPhrases.map((phrase) => '"' + phrase.replace(/"/g, '') + '"'),
  ].join(' ');
}

export function dateBounds(spec: SearchSpec, now: Date) {
  const range = spec.dateRange;
  if (range)
    return {
      start: range.start + 'T00:00:00.000Z',
      end: range.end + 'T23:59:59.999Z',
    };
  if (!spec.recency) return;
  const days = { day: 1, week: 7, month: 30, year: 365 };
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days[spec.recency]);
  return { start: start.toISOString() };
}

export function normalizeResults(
  provider: string,
  spec: SearchSpec,
  now: Date,
  rows: readonly {
    url: string;
    title: string;
    snippet: string;
    date?: string | null | undefined;
  }[],
): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const bounds = dateBounds(spec, now);
  for (const [index, row] of rows.entries()) {
    const url = canonicalUrl(row.url);
    if (!url || seen.has(url.href)) continue;
    if (!matchesSourceDomains(url, spec.includeDomains, spec.excludeDomains))
      continue;

    const time = row.date ? Date.parse(row.date) : NaN;
    const publishedAt = Number.isFinite(time)
      ? new Date(time).toISOString()
      : undefined;
    if (
      bounds &&
      (!publishedAt ||
        publishedAt < bounds.start ||
        ('end' in bounds && bounds.end && publishedAt > bounds.end))
    )
      continue;
    const parsed = SearchResultSchema.safeParse({
      url: url.href,
      title: row.title,
      snippet: row.snippet,
      provider,
      publishedAt,
      rank: index + 1,
    });
    if (!parsed.success) continue;
    seen.add(url.href);
    results.push(parsed.data);
  }
  return results;
}
