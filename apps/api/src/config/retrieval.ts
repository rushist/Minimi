import { z } from 'zod';

export const trustTiers = {
  primary: [
    'nodejs.org',
    'docs.python.org',
    'developer.chrome.com',
    'docs.docker.com',
    'nasa.gov',
    'who.int',
    'sec.gov',
  ],
  reference: ['developer.mozilla.org', 'wikipedia.org', 'britannica.com'],
  news: ['reuters.com', 'apnews.com', 'bbc.com'],
  forum: ['reddit.com', 'stackoverflow.com', 'quora.com'],
} as const;

const schema = z.object({
  SEMANTIC_SEARCH_CACHE_ENABLED: z.enum(['true', 'false']).default('true'),
  RETRIEVAL_EMBEDDING_DIR: z
    .string()
    .trim()
    .min(1)
    .default('.data/models/embedding'),
  RETRIEVAL_EMBEDDING_REVISION: z
    .string()
    .trim()
    .min(1)
    .default('751bff37182d3f1213fa05d7196b954e230abad9'),
  RETRIEVAL_RERANK_ENABLED: z.enum(['true', 'false']).default('false'),
  RETRIEVAL_RERANK_DIR: z
    .string()
    .trim()
    .min(1)
    .default('.data/models/reranker'),
});

export function readRetrievalEnv(env: Record<string, string | undefined>) {
  return schema.parse(env);
}
