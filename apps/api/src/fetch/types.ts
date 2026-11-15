import { z } from 'zod';

export const FetchInputSchema = z.object({
  url: z.string().trim().min(1).max(8192),
});
export const ExtractedPageSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  text: z.string().trim().min(1),
  kind: z.enum(['html', 'pdf', 'text']),
  retrievedAt: z.iso.datetime(),
});
export type ExtractedPage = z.infer<typeof ExtractedPageSchema>;

export type FetchError =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns'
  | 'timeout'
  | 'aborted'
  | 'redirect_limit'
  | 'too_large'
  | 'unsupported_type'
  | 'forbidden'
  | 'paywall'
  | 'http_error'
  | 'network_error'
  | 'extraction_failed';
export type FetchOutcome =
  | { ok: true; page: ExtractedPage; revalidated: boolean }
  | { ok: false; error: FetchError };

export class FetchFailure extends Error {
  constructor(readonly code: FetchError) {
    super(code);
  }
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export interface PageTransport {
  open(
    url: URL,
    address: PinnedAddress,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: AsyncIterable<Uint8Array>;
    dispose(): Promise<void>;
  }>;
}

export type Resolver = (host: string) => Promise<readonly PinnedAddress[]>;
export type HtmlRenderer = (
  html: string,
  signal: AbortSignal,
) => Promise<string>;
