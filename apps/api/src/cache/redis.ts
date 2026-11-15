import { createClient } from 'redis';
import { fallbackStore, memoryStore, type CacheStore } from './store.js';

export function openCacheStore(
  url: string,
  options: { commandTimeoutMs?: number; maxEntries?: number } = {},
) {
  const timeout = options.commandTimeoutMs ?? 200;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: timeout,
      reconnectStrategy: (attempt) =>
        Math.min(100 * 2 ** Math.min(attempt, 5), 3000),
    },
  });
  client.on('error', () => {});
  const ready = client.connect();
  void ready.catch(() => {});
  const redis: CacheStore = {
    async get(key) {
      if (!client.isReady) throw new Error('Redis unavailable');
      return client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(timeout) })
        .get(key);
    },
    async set(key, value, ttlMs) {
      if (!client.isReady) throw new Error('Redis unavailable');
      await client
        .withCommandOptions({ abortSignal: AbortSignal.timeout(timeout) })
        .set(key, value, { expiration: { type: 'PX', value: ttlMs } });
    },
  };
  return {
    client,
    store: fallbackStore(redis, memoryStore(options.maxEntries)),
    ready,
    close() {
      if (client.isOpen) client.destroy();
    },
  };
}
