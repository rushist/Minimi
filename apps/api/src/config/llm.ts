import { z } from 'zod';

const providerSettings = z.object({
  apiKey: z.string().trim().min(1),
  small: z.string().trim().min(1),
  strong: z.string().trim().min(1),
});

export const llmPolicy = {
  retries: 1,
  backoffMs: 200,
  maxRetryWaitMs: 1000,
  timeoutMs: 5000,
  failureThreshold: 2,
  cooldownMs: 30_000,
} as const;

export function readLlmEnv(env: Record<string, string | undefined>) {
  return (
    [
      {
        name: 'groq',
        prefix: 'GROQ',
        baseUrl: 'https://api.groq.com/openai/v1',
      },
      {
        name: 'gemini',
        prefix: 'GEMINI',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
    ] as const
  ).flatMap(({ name, prefix, baseUrl }) => {
    const apiKey = env[prefix + '_API_KEY'];
    const small = env[prefix + '_SMALL_MODEL'];
    const strong = env[prefix + '_STRONG_MODEL'];
    if (!apiKey?.trim()) return [];
    const parsed = providerSettings.safeParse({ apiKey, small, strong });
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map(({ path }) => path.join('.'))
        .join(', ');
      throw new Error('Incomplete ' + prefix + ' LLM settings: ' + fields);
    }
    return [
      {
        name,
        baseUrl,
        apiKey: parsed.data.apiKey,
        models: { small: parsed.data.small, strong: parsed.data.strong },
        streamUsageOption: true,
      },
    ];
  });
}
