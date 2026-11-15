import type { SearchResult, SearchSpec } from '@chatagent/shared';

export type SearchError =
  | 'invalid_spec'
  | 'unconfigured'
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'unavailable'
  | 'rejected'
  | 'invalid_response'
  | 'fixture_missing'
  | 'fixture_io'
  | 'budget_exhausted'
  | 'quota_exhausted'
  | 'quota_unavailable'
  | 'circuit_open';
export type SearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; error: SearchError; retryAfterMs?: number };

export interface SearchControl {
  reserveCredits(units: number): (() => void) | undefined;
}

export interface SearchProvider {
  name: string;
  search(
    spec: SearchSpec,
    signal?: AbortSignal,
    control?: SearchControl,
  ): Promise<SearchOutcome>;
}

export interface SearchRequest {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface SearchResponse {
  status: number;
  body: unknown;
  retryAfter?: string | null;
}

export interface SearchTransport {
  send(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}

export class SearchFailure extends Error {
  constructor(readonly code: SearchError) {
    super(code);
  }
}
