import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { openCacheStore } from '../cache/redis.js';

export interface RateLimiter {
  check(ip: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}
type Redis = ReturnType<typeof openCacheStore>['client'];
const result = z.tuple([z.number(), z.number()]);
const script = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return {count, redis.call('PTTL', KEYS[1])}
`;

export function createRateLimiter(
  limit: number,
  windowSeconds: number,
  redis?: Redis,
  now = Date.now,
): RateLimiter {
  const windowMs = windowSeconds * 1000;
  const local = new Map<string, { count: number; expires: number }>();
  const decision = (count: number, ttl: number) => ({
    allowed: count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
  });
  return {
    async check(ip) {
      const key =
        'chatagent:rate:chat:' + createHash('sha256').update(ip).digest('hex');
      if (redis?.isReady) {
        try {
          const [count, ttl] = result.parse(
            await redis
              .withCommandOptions({ abortSignal: AbortSignal.timeout(150) })
              .eval(script, {
                keys: [key],
                arguments: [String(windowMs)],
              }),
          );
          return decision(count, ttl > 0 ? ttl : windowMs);
        } catch {
          // Keep a bounded per-process limit while Redis reconnects.
        }
      }
      const current = now();
      const saved = local.get(key);
      const bucket =
        saved && saved.expires > current
          ? saved
          : { count: 0, expires: current + windowMs };
      bucket.count++;
      local.delete(key);
      local.set(key, bucket);
      if (local.size > 4096) local.delete(local.keys().next().value!);
      return decision(bucket.count, bucket.expires - current);
    },
  };
}
