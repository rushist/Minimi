import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import ipaddr from 'ipaddr.js';
import { waitFor } from '../resilience/wait-for.js';

function normalize(address: string | undefined): string | undefined {
  if (!address || !isIP(address)) return;
  return ipaddr.process(address).toNormalizedString();
}

export function createClientIp(trustedProxyHost?: string) {
  let peers: string[] = [];
  let refreshAt = 0;
  let refreshing: Promise<void> | undefined;
  return async (context: Context) => {
    let peer: string | undefined;
    try {
      peer = normalize(getConnInfo(context).remote.address);
    } catch {
      /* In-memory requests share a local limit. */
    }
    if (!peer) return 'unknown';
    const forwarded = normalize(context.req.header('x-real-ip'));
    if (!trustedProxyHost || !forwarded) return peer;
    if (Date.now() >= refreshAt) {
      refreshing ??= waitFor(
        lookup(trustedProxyHost, { all: true }),
        AbortSignal.timeout(100),
      )
        .then(
          (answers) => {
            peers = answers.flatMap(({ address }) => normalize(address) ?? []);
          },
          () => {
            peers = [];
          },
        )
        .finally(() => {
          refreshAt = Date.now() + 10_000;
          refreshing = undefined;
        });
      await refreshing;
    }
    return peers.includes(peer) ? forwarded : peer;
  };
}
