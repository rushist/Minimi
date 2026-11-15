import { createHash } from 'node:crypto';
import type { SearchSpec } from '@chatagent/shared';
import { canonicalUrl } from '../url.js';
import { defaults } from '../config/index.js';

export const cachePrefix = 'chatagent:evidence:v1:';
export type Volatility = SearchSpec['volatility'];
export const ttlMs = (volatility: Volatility | 'negative') =>
  defaults.cacheTtlSeconds[volatility] * 1000;
export const staleMs = (volatility: Volatility) =>
  Math.floor(ttlMs(volatility) / 2);
export const contentHash = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex');
const key = (layer: string, fields: readonly unknown[]) =>
  cachePrefix + layer + ':' + contentHash(JSON.stringify(fields));
const domains = (values: string[]) =>
  [...new Set(values.map((value) => value.toLowerCase()))].sort();

export function searchKey(
  spec: SearchSpec,
  provider: string,
  now: number,
  previousBucket = false,
) {
  // Keep case and punctuation significant for error codes and exact lookups.
  return key('search', [
    provider,
    spec.query.trim().replace(/\s+/g, ' '),
    spec.exactPhrases,
    domains(spec.includeDomains),
    domains(spec.excludeDomains),
    spec.recency,
    spec.dateRange?.start,
    spec.dateRange?.end,
    spec.topic,
    spec.intent,
    spec.volatility,
    spec.recency ? new Date(now).toISOString().slice(0, 10) : null,
    Math.floor(now / ttlMs(spec.volatility)) - Number(previousBucket),
  ]);
}

export function semanticSearchKey(
  spec: SearchSpec,
  provider: string,
  model: string,
  anchors: string,
) {
  return key('semantic-search', [
    model,
    provider,
    anchors,
    spec.topic,
    spec.intent,
    spec.volatility,
    spec.exactPhrases,
    domains(spec.includeDomains),
    domains(spec.excludeDomains),
    spec.dateRange?.start,
    spec.dateRange?.end,
  ]);
}

export function pageKey(url: string) {
  const normalized = canonicalUrl(url);
  return normalized ? key('page', [normalized.href]) : undefined;
}

export function chunkKey(url: string, hash: string, version: string) {
  const normalized = canonicalUrl(url);
  return normalized
    ? key('chunks', [normalized.href, hash, version])
    : undefined;
}

export function embeddingKey(url: string, hash: string, model: string) {
  const normalized = canonicalUrl(url);
  return normalized
    ? key('embeddings', [normalized.href, hash, model])
    : undefined;
}
