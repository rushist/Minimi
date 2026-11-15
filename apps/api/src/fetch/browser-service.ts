import { createServer, type IncomingMessage } from 'node:http';
import { unlink } from 'node:fs/promises';
import { chromium } from 'playwright';
import { waitFor } from '../resilience/wait-for.js';
import { pageFetchPolicy } from './index.js';

const socketPath = '/renderer/browser.sock';
const { maxBytes, timeoutMs } = pageFetchPolicy;
let rendering = false;

async function readHtml(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Input too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function renderHtml(html: string, signal: AbortSignal) {
  const launching = chromium.launch({ timeout: timeoutMs });
  try {
    const browser = await waitFor(launching, signal);
    const context = await waitFor(
      browser.newContext({
        offline: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
      }),
      signal,
    );
    await context.route('**/*', (route) => route.abort());
    await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await waitFor(context.newPage(), signal);
    await waitFor(
      page.setContent(html, {
        timeout: timeoutMs,
        waitUntil: 'domcontentloaded',
      }),
      signal,
    );
    return await waitFor(page.content(), signal);
  } finally {
    // If launch is still in progress when the caller disconnects, close it as soon as it settles.
    await launching.then((browser) => browser.close()).catch(() => {});
  }
}

await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
});
const server = createServer(
  { requestTimeout: timeoutMs, headersTimeout: timeoutMs },
  async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/render') {
      response.writeHead(404).end();
      return;
    }
    if (rendering) {
      response.writeHead(503).end();
      return;
    }
    rendering = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    response.once('close', () => controller.abort());
    try {
      const html = await waitFor(readHtml(request), signal);
      const rendered = await renderHtml(html, signal);
      if (Buffer.byteLength(rendered) > maxBytes) {
        response.writeHead(413).end();
      } else {
        response
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(rendered);
      }
    } catch {
      if (!response.destroyed) response.writeHead(422).end();
    } finally {
      rendering = false;
    }
  },
);

server.listen(socketPath);
process.once('SIGTERM', () => server.close());
