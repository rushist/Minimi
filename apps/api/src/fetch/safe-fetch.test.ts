import { describe, expect, it, vi } from 'vitest';
import { extractHtml } from './extract-html.js';
import { extractPdf } from './extract-pdf.js';
import type { ExtractionInput } from './worker.js';
import { createPageFetcher } from './index.js';
import type { PageTransport } from './types.js';

const extract = async (input: ExtractionInput) =>
  input.kind === 'pdf'
    ? extractPdf(input.data, input.maxPages, input.maxTextChars)
    : extractHtml(input.data, input.url, input.contentType);

const url = 'https://example.org/article';
const html =
  '<html><head><title>Example</title></head><body><article><h1>Example</h1><p>Evidence belongs in the article. This paragraph contains the text that the extractor returns.</p></article></body></html>';
const resolve = async () => [{ address: '93.184.216.34', family: 4 as const }];
const policy = {
  timeoutMs: 1000,
  maxBytes: 1024,
  maxRedirects: 2,
  negativeTtlMs: 100,
  cacheEntries: 8,
  maxTextChars: 10000,
};
function response(
  status: number,
  headers: Record<string, string>,
  ...chunks: string[]
) {
  return {
    status,
    headers,
    dispose: vi.fn(async () => {}),
    async *bodyChunks() {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk);
    },
    get body() {
      return this.bodyChunks();
    },
  };
}

describe('safe page fetching', () => {
  it('rejects a malformed PDF without exposing an extracted passage', async () => {
    const open = vi.fn<PageTransport['open']>(async () =>
      response(
        200,
        { 'content-type': 'application/pdf' },
        '%PDF-1.4\ntruncated document',
      ),
    );
    const fetchPage = createPageFetcher(policy, {
      resolve,
      extract,
      transport: { open },
    });
    expect(await fetchPage(url)).toEqual({
      ok: false,
      error: 'extraction_failed',
    });
  });

  it.each([
    'http://127.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.1.1/',
    'http://10.0.0.1/',
  ])('blocks %s before making a request', async (input) => {
    const open = vi.fn<PageTransport['open']>();
    const fetchPage = createPageFetcher(policy, {
      resolve,
      transport: { open },
    });
    expect(await fetchPage(input)).toEqual({
      ok: false,
      error: 'blocked_address',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('validates every redirect and refuses a mixed public/private DNS answer', async () => {
    const first = response(302, { location: 'https://internal.example.org/' });
    const open = vi.fn<PageTransport['open']>(async () => first);
    const resolver = vi.fn(async (host: string) =>
      host.startsWith('internal')
        ? [
            { address: '93.184.216.34', family: 4 as const },
            { address: '192.168.0.1', family: 4 as const },
          ]
        : resolve(),
    );
    expect(
      await createPageFetcher(policy, {
        resolve: resolver,
        transport: { open },
      })(url),
    ).toEqual({ ok: false, error: 'blocked_address' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1]).toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('rejects an oversized streaming response and disposes the body', async () => {
    const body = response(
      200,
      { 'content-type': 'text/plain' },
      'x'.repeat(600),
      'y'.repeat(600),
    );
    const open = vi.fn<PageTransport['open']>(async () => body);
    expect(
      await createPageFetcher(policy, {
        resolve,
        transport: { open },
        extract,
      })(url),
    ).toEqual({ ok: false, error: 'too_large' });
    expect(body.dispose).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent requests and revalidates via both HTTP validators', async () => {
    const open = vi
      .fn<PageTransport['open']>()
      .mockResolvedValueOnce(
        response(
          200,
          {
            'content-type': 'text/html',
            etag: '"v1"',
            'last-modified': 'Mon, 02 Nov 2026 12:00:00 GMT',
          },
          html,
        ),
      )
      .mockResolvedValueOnce(response(304, {}));
    const fetchPage = createPageFetcher(policy, {
      resolve,
      transport: { open },
      extract,
    });
    const [first, second] = await Promise.all([fetchPage(url), fetchPage(url)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      page: {
        title: 'Example',
        text: expect.stringContaining('Evidence belongs'),
      },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(await fetchPage(url)).toMatchObject({ ok: true, revalidated: true });
    expect(open.mock.calls[1]![2]).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Mon, 02 Nov 2026 12:00:00 GMT',
    });
  });

  it('uses the renderer only when enabled and only for an empty HTML extraction', async () => {
    const shell =
      '<html><body><div id="app"></div><script>render()</script></body></html>';
    const open = vi.fn<PageTransport['open']>(async () =>
      response(200, { 'content-type': 'text/html' }, shell),
    );
    const render = vi.fn(async () => html);
    const deps = { resolve, transport: { open }, render, extract };
    expect(await createPageFetcher(policy, deps)(url)).toEqual({
      ok: false,
      error: 'extraction_failed',
    });
    expect(render).not.toHaveBeenCalled();
    expect(
      await createPageFetcher({ ...policy, browserEnabled: true }, deps)(url),
    ).toMatchObject({ ok: true, page: { kind: 'html' } });
    expect(render).toHaveBeenCalledOnce();
  });

  it('times out during DNS and caches the timeout', async () => {
    const resolve = vi.fn(() => new Promise<never>(() => {}));
    const open = vi.fn<PageTransport['open']>();
    const fetchPage = createPageFetcher(
      { ...policy, timeoutMs: 20 },
      { resolve, transport: { open } },
    );
    expect(await fetchPage(url)).toEqual({ ok: false, error: 'timeout' });
    expect(await fetchPage(url)).toEqual({ ok: false, error: 'timeout' });
    expect(resolve).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'forbidden'],
    [402, 'paywall'],
  ] as const)(
    'negative-caches HTTP %s and retries after the TTL',
    async (status, error) => {
      const open = vi.fn<PageTransport['open']>(async () =>
        response(status, {}),
      );
      let now = 0;
      const fetchPage = createPageFetcher(policy, {
        resolve,
        transport: { open },
        now: () => now,
      });
      expect(await fetchPage(url)).toEqual({ ok: false, error });
      expect(await fetchPage(url)).toEqual({ ok: false, error });
      expect(open).toHaveBeenCalledOnce();
      now = 101;
      expect(await fetchPage(url)).toEqual({ ok: false, error });
      expect(open).toHaveBeenCalledTimes(2);
    },
  );
});
