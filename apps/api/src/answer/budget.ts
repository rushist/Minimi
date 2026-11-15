import { defaults } from '../config/index.js';
import type { LLMStats } from '../llm/types.js';

export function createAnswerBudget(
  prior: { tokensUsed: number; llmCalls: number; elapsedMs: number },
  parent?: AbortSignal,
) {
  const limits = defaults.research;
  const deadline = new AbortController();
  const timeLeft = limits.maxWallClockMs - prior.elapsedMs;
  const expiresAt = performance.now() + timeLeft;
  const timer =
    timeLeft > 0 ? setTimeout(() => deadline.abort(), timeLeft) : undefined;
  if (!timer) deadline.abort();
  const signal = parent
    ? AbortSignal.any([parent, deadline.signal])
    : deadline.signal;
  let tokensUsed = prior.tokensUsed;
  let llmCalls = prior.llmCalls;
  let reserved = 0;

  return {
    signal,
    remainingMs: () => Math.max(0, expiresAt - performance.now()),
    reserve(
      system: string,
      context: string,
      outputLimit: number,
      maxCalls = 1,
      minOutput = 64,
      keepTokens = 0,
    ) {
      if (signal.aborted) return;
      const input = Math.ceil(Buffer.byteLength(system + context) / 2) + 256;
      const output = Math.min(
        outputLimit,
        Math.floor(
          (limits.maxTokens - tokensUsed - reserved - keepTokens) / maxCalls,
        ) - input,
      );
      if (output < minOutput) return;
      const allowance = (input + output) * maxCalls;
      reserved += allowance;
      let settled = false;
      return {
        maxOutputTokens: output,
        finish(stats?: LLMStats) {
          if (settled) return;
          settled = true;
          reserved -= allowance;
          const calls = stats?.calls ?? maxCalls;
          llmCalls += calls;
          const unreported =
            calls - (stats?.usageReports ?? 0) - (stats?.rateLimitedCalls ?? 0);
          tokensUsed +=
            (stats?.inputTokens ?? 0) +
            (stats?.outputTokens ?? 0) +
            (input + output) * Math.max(0, unreported);
        },
      };
    },
    usage: () => ({ tokensUsed, llmCalls }),
    expired: () => deadline.signal.aborted,
    close() {
      clearTimeout(timer);
      deadline.abort();
    },
  };
}

export type AnswerBudget = ReturnType<typeof createAnswerBudget>;
