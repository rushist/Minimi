import { SearchSpecSchema, type SearchSpec } from '@chatagent/shared';
import type { FilterLocks } from './types.js';

const wider = {
  day: 'week',
  week: 'month',
  month: 'year',
  year: undefined,
} as const;
const dayMs = 86_400_000;

export function relaxSpec(
  spec: SearchSpec,
  locks: FilterLocks,
): SearchSpec | undefined {
  if (!locks.exact && spec.exactPhrases.length)
    return { ...spec, exactPhrases: [] };
  if (!locks.domains && spec.includeDomains.length)
    return { ...spec, includeDomains: [] };
  if (locks.dates) return;
  if (spec.recency) return { ...spec, recency: wider[spec.recency] };
  if (spec.dateRange) {
    const start = Date.parse(spec.dateRange.start);
    const end = Date.parse(spec.dateRange.end);
    const extension = Math.max(end - start, 7 * dayMs);
    const result = SearchSpecSchema.safeParse({
      ...spec,
      dateRange: {
        start: new Date(Math.max(Date.parse('0000-01-01'), start - extension))
          .toISOString()
          .slice(0, 10),
        end: new Date(Math.min(Date.parse('9999-12-31'), end + extension))
          .toISOString()
          .slice(0, 10),
      },
    });
    if (result.success) return result.data;
  }
}
