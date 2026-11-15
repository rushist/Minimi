import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379'),
});

export function readEnv(input: Record<string, string | undefined>) {
  return envSchema.parse(input);
}

export const defaults = {
  research: {
    maxLoops: 3,
    maxSearches: 3,
    maxSearchCredits: 3,
    maxTokens: 18000,
    maxPages: 4,
    fetchTimeoutMs: 3000,
    maxWallClockMs: 25000,
    passages: 8,
  },
  cacheTtlSeconds: { fast: 600, medium: 21600, slow: 259200, negative: 600 },
  degradeThreshold: 0.8,
} as const;
