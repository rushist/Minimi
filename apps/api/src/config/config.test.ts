import { describe, expect, it } from 'vitest';
import { defaults, readEnv } from './index.js';

describe('configuration', () => {
  it('starts without credentials and accepts explicit runtime settings', () => {
    expect(readEnv({}).PORT).toBe(3000);
    expect(
      readEnv({ PORT: '4123', REDIS_URL: 'rediss://localhost:6379' }),
    ).toMatchObject({
      PORT: 4123,
      REDIS_URL: 'rediss://localhost:6379',
    });
  });

  it('rejects malformed ports and non-Redis URLs', () => {
    expect(() => readEnv({ PORT: '65536' })).toThrow();
    expect(() => readEnv({ REDIS_URL: 'https://localhost' })).toThrow();
  });

  it('sets research limits and volatility TTLs', () => {
    expect(defaults.research).toMatchObject({
      maxLoops: 3,
      maxSearches: 3,
      maxPages: 4,
      maxWallClockMs: 25000,
    });
    expect(defaults.cacheTtlSeconds.fast).toBeLessThan(
      defaults.cacheTtlSeconds.medium,
    );
    expect(defaults.cacheTtlSeconds.medium).toBeLessThan(
      defaults.cacheTtlSeconds.slow,
    );
  });
});
