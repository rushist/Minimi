import type { z } from 'zod';

export type ModelTier = 'small' | 'strong';
export type LLMPurpose =
  'router' | 'planner' | 'sufficiency' | 'deep_verification' | 'synthesis';

export interface LLMRequest {
  purpose: LLMPurpose;
  system: string;
  toolDefinitions?: readonly string[];
  context: string;
  maxOutputTokens?: number;
  jsonObject?: boolean;
  reasoningEffort?: 'low';
  maxProviderCalls?: number;
  skipProviderRetries?: boolean;
  timeoutMs?: number;
  includeSchemaInPrompt?: boolean;
  requestId?: string;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMStats extends TokenUsage {
  calls: number;
  usageReports: number;
  rateLimitedCalls?: number;
}

export type LLMError =
  | 'unconfigured'
  | 'aborted'
  | 'timeout'
  | 'rate_limit'
  | 'unavailable'
  | 'rejected'
  | 'invalid_output'
  | 'circuit_open'
  | 'quota_exhausted'
  | 'quota_unavailable';

export class LLMFailure extends Error {
  constructor(
    readonly code: LLMError,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export type LLMResult<T> =
  | { ok: true; value: T; stats: LLMStats }
  | { ok: false; error: LLMError; stats: LLMStats };

export type LLMStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; stats: LLMStats }
  | { type: 'error'; error: LLMError; stats: LLMStats };

export interface LLMProvider {
  generate(request: LLMRequest): Promise<LLMResult<string>>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
  generateStructured<S extends z.ZodType>(
    request: LLMRequest,
    schema: S,
  ): Promise<LLMResult<z.output<S>>>;
}

export interface BackendRequest {
  model: string;
  messages: readonly { role: 'system' | 'user'; content: string }[];
  stream: boolean;
  maxOutputTokens?: number;
  jsonObject?: boolean;
  reasoningEffort?: LLMRequest['reasoningEffort'];
}

export type BackendEvent =
  { type: 'token'; text: string } | { type: 'usage'; usage: TokenUsage };

export interface ModelBackend {
  name: string;
  models: Readonly<Record<ModelTier, string>>;
  complete(
    request: BackendRequest,
    signal: AbortSignal,
  ): AsyncIterable<BackendEvent>;
}
