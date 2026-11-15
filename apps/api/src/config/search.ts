import { z } from 'zod';
import { defaults } from './index.js';
import { openQuotaMeter } from '../store/quota.js';

const optional = <S extends z.ZodType>(schema: S) =>
  z.preprocess(
    (input) => (input === '' ? undefined : input),
    schema.optional(),
  );
const limit = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional();
const optionalLimit = z.preprocess(
  (input) => (input === '' ? undefined : input),
  limit,
);
const schema = z.object({
  TAVILY_API_KEY: z.string().trim().optional(),
  EXA_API_KEY: z.string().trim().optional(),
  SEARXNG_URL: optional(
    z.url({ protocol: /^https?$/ }).refine((value) => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    }),
  ),
  TAVILY_MONTHLY_CREDITS: optionalLimit,
  EXA_MONTHLY_MICRODOLLARS: optionalLimit,
  EXA_SEARCH_RESERVE_MICRODOLLARS: optionalLimit,
  GROQ_DAILY_REQUESTS: optionalLimit,
  GEMINI_DAILY_REQUESTS: optionalLimit,
  QUOTA_DB_PATH: z.string().min(1).default('.data/quota.sqlite'),
  SEARCH_MODE: z.enum(['live', 'record', 'replay']).default('live'),
  SEARCH_FIXTURE_DIR: z
    .string()
    .min(1)
    .default('evals/fixtures/search/recorded'),
});

export const searchPolicy = {
  adapterTimeoutMs: 4500,
  failureThreshold: 2,
  cooldownMs: 30_000,
} as const;

export function readSearchEnv(env: Record<string, string | undefined>) {
  return schema.parse(env);
}

export function configureQuota(config: ReturnType<typeof readSearchEnv>) {
  const limits = {
    ...(config.TAVILY_MONTHLY_CREDITS !== undefined
      ? { tavily: config.TAVILY_MONTHLY_CREDITS }
      : {}),
    ...(config.EXA_MONTHLY_MICRODOLLARS !== undefined
      ? { exa: config.EXA_MONTHLY_MICRODOLLARS }
      : {}),
    ...(config.GROQ_DAILY_REQUESTS !== undefined
      ? { groq: config.GROQ_DAILY_REQUESTS }
      : {}),
    ...(config.GEMINI_DAILY_REQUESTS !== undefined
      ? { gemini: config.GEMINI_DAILY_REQUESTS }
      : {}),
  };
  return openQuotaMeter(
    config.QUOTA_DB_PATH,
    limits,
    defaults.degradeThreshold,
  );
}
