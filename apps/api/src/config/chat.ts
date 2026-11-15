import { z } from 'zod';

const origin = z
  .url({ protocol: /^https?$/ })
  .refine((value) => new URL(value).origin === value);
const localOrigins = [3000, 5173, 8080, 18080].flatMap((port) =>
  ['localhost', '127.0.0.1'].map((host) => 'http://' + host + ':' + port),
);
const config = z.object({
  CHAT_DB_PATH: z.string().min(1).default('.data/chat.sqlite'),
  CHAT_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? localOrigins
        : value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    )
    .pipe(z.array(origin)),
  CHAT_SECURE_COOKIE: z.enum(['true', 'false']).default('false'),
  CHAT_TRUSTED_PROXY_HOST: z.string().trim().max(253).optional(),
  CHAT_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  CHAT_RATE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(60),
});

export function readChatEnv(env: Record<string, string | undefined>) {
  return config.parse(env);
}
