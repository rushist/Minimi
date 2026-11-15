import { llmPolicy, readLlmEnv } from '../config/llm.js';
import type { QuotaMeter } from '../store/quota.js';
import type { Tracer } from '../telemetry/tracer.js';
import { openAICompatible } from './openai-compatible.js';
import { createProvider } from './provider.js';
import type { LLMProvider } from './types.js';

export type {
  LLMProvider,
  LLMRequest,
  LLMResult,
  LLMStreamEvent,
} from './types.js';

export function configureLLM(
  env: Record<string, string | undefined>,
  tracer: Tracer,
  meter?: QuotaMeter,
): LLMProvider {
  return createProvider(
    readLlmEnv(env).map((config) => openAICompatible(config)),
    llmPolicy,
    {
      tracer,
      ...(meter
        ? {
            reserveCall: (provider: string) => {
              if (provider === 'groq' || provider === 'gemini')
                return meter.reserve(provider);
              return false;
            },
          }
        : {}),
    },
  );
}
