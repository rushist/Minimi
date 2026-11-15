import { z } from 'zod';

const schema = z.object({
  TRACE_DB_PATH: z.string().min(1).default('.data/traces.sqlite'),
  TRACE_REPLAY_ENABLED: z.enum(['true', 'false']).default('false'),
  LANGFUSE_BASE_URL: z.string().default('https://cloud.langfuse.com'),
  LANGFUSE_PUBLIC_KEY: z.string().trim().optional(),
  LANGFUSE_SECRET_KEY: z.string().trim().optional(),
});

export function readTraceEnv(env: Record<string, string | undefined>) {
  return schema.parse(env);
}
