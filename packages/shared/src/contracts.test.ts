import { describe, expect, it } from 'vitest';
import { SearchSpecSchema, StreamEventSchema } from './index.js';

const spec = {
  query: 'current documentation',
  exactPhrases: [],
  includeDomains: ['example.com'],
  excludeDomains: [],
  topic: 'general',
  intent: 'official_docs',
  volatility: 'medium',
};

describe('shared contracts', () => {
  it('accepts a valid search and rejects conflicting dates and malformed domains', () => {
    expect(
      SearchSpecSchema.safeParse({ ...spec, recency: 'week' }).success,
    ).toBe(true);
    const dateRange = { start: '2026-10-01', end: '2026-10-31' };
    expect(
      SearchSpecSchema.safeParse({ ...spec, recency: 'week', dateRange })
        .success,
    ).toBe(false);
    expect(
      SearchSpecSchema.safeParse({
        ...spec,
        includeDomains: ['https://example.com'],
      }).success,
    ).toBe(false);
  });

  it('discriminates stream events and validates citation IDs', () => {
    expect(
      StreamEventSchema.safeParse({ type: 'citation', id: 'S2' }).success,
    ).toBe(true);
    expect(
      StreamEventSchema.safeParse({ type: 'citation', id: 'S0' }).success,
    ).toBe(false);
    expect(
      StreamEventSchema.safeParse({ type: 'done', text: 'done' }).success,
    ).toBe(false);
  });
});
