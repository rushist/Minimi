export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export function memoryStore(
  maxEntries = 128,
  now = Date.now,
  maxBytes = 16 * 1024 * 1024,
): CacheStore {
  const entries = new Map<
    string,
    { value: string; expires: number; size: number }
  >();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.size;
    entries.delete(key);
  }
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expires <= now()) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    async set(key, value, ttlMs) {
      remove(key);
      const size = (key.length + value.length) * 2;
      if (size > maxBytes || maxEntries < 1) return;
      entries.set(key, { value, expires: now() + ttlMs, size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes)
        remove(entries.keys().next().value!);
    },
  };
}

export function fallbackStore(
  primary: CacheStore,
  fallback: CacheStore,
): CacheStore {
  return {
    async get(key) {
      const result = await primary.get(key).catch(() => null);
      return result ?? fallback.get(key);
    },
    async set(key, value, ttlMs) {
      await fallback.set(key, value, ttlMs);
      await primary.set(key, value, ttlMs).catch(() => {});
    },
  };
}
