import { lookup } from 'node:dns/promises';
import { waitFor } from '../resilience/wait-for.js';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import {
  FetchFailure,
  type PageTransport,
  type PinnedAddress,
  type Resolver,
} from './types.js';

export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );

export function parsePageUrl(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new FetchFailure('invalid_url');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new FetchFailure('invalid_url');
  // Limit egress to standard web ports. WHATWG URL removes explicit default ports.
  if (url.port) throw new FetchFailure('invalid_url');
  url.hash = '';
  return url;
}

function isPublic({ address, family }: PinnedAddress): boolean {
  if (isIP(address) !== family) return false;
  const ip = ipaddr.parse(address);
  if (ip instanceof ipaddr.IPv4) return ip.range() === 'unicast';
  return ip.range() === 'unicast' && ip.match(ipaddr.IPv6.parse('2000::'), 3);
}

export async function resolveAddress(
  url: URL,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<PinnedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(host);
  let answers: readonly PinnedAddress[];
  try {
    answers =
      family === 4 || family === 6
        ? [{ address: host, family }]
        : await waitFor(resolve(host), signal);
  } catch {
    signal.throwIfAborted();
    throw new FetchFailure('dns');
  }
  if (!answers.length) throw new FetchFailure('dns');
  if (answers.some((address) => !isPublic(address)))
    throw new FetchFailure('blocked_address');
  return answers.find((answer) => answer.family === 4) ?? answers[0]!;
}

export const undiciTransport: PageTransport = {
  async open(url, pinned, headers, signal) {
    // The request URL keeps the hostname for Host and TLS verification.
    // Each hop gets its own dispatcher with a lookup that can only return the vetted address.
    const dispatcher = new Agent({
      autoSelectFamily: false,
      connect: {
        lookup: (_host, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      },
    });
    try {
      const response = await request(url, {
        dispatcher,
        signal,
        headers: { ...headers, 'accept-encoding': 'identity' },
      });
      // Redirects and rejected responses may be disposed without a body reader.
      // Keep an abort error handled even when no async iterator was attached.
      response.body.on('error', () => {});
      return {
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
        async dispose() {
          response.body.destroy();
          await dispatcher.destroy();
        },
      };
    } catch (error) {
      await dispatcher.destroy();
      throw error;
    }
  },
};
