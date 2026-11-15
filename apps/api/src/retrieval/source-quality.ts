import { trustTiers } from '../config/retrieval.js';
import type { RetrievalInput, Source } from './types.js';

const base = { primary: 0.9, reference: 0.72, news: 0.55, forum: 0.3 } as const;

export function sourceQuality(
  source: Source,
  volatility: NonNullable<RetrievalInput['volatility']>,
  now: number,
): number {
  const url = new URL(source.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  let quality = 0.45;
  let specificity = 0;
  for (const [tier, domains] of Object.entries(trustTiers)) {
    for (const domain of domains) {
      if (
        domain.length <= specificity ||
        !(host === domain || host.endsWith('.' + domain))
      )
        continue;
      specificity = domain.length;
      quality = base[tier as keyof typeof base];
    }
  }
  const publication = source.publishedAt ? Date.parse(source.publishedAt) : NaN;
  if (Number.isFinite(publication) && publication <= now) {
    const days = (now - publication) / 86_400_000;
    const halfLife = { fast: 2, medium: 30, slow: 365 }[volatility];
    quality += 0.1 * 2 ** (-days / halfLife);
  }
  if (
    ['affiliate', 'aff', 'affid', 'referral', 'tag'].some((key) =>
      url.searchParams.has(key),
    ) ||
    /\b(affiliate disclosure|sponsored post|best deals|coupon codes)\b/i.test(
      source.title + ' ' + source.text.slice(0, 1500),
    )
  ) {
    quality -= 0.16;
  }
  return Math.max(0, Math.min(1, quality));
}
