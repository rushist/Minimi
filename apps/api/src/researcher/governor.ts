import { defaults } from '../config/index.js';
import type { LLMStats } from '../llm/types.js';
import type { QuotaMeter } from '../store/quota.js';
import type { ResearchReason } from './types.js';

export interface ResearchLimits {
  maxLoops: number;
  maxSearches: number;
  maxPages: number;
  maxSearchCredits: number;
  maxTokens: number;
  maxWallClockMs: number;
  passages: number;
}
type Counter = 'loops' | 'searches' | 'pages';
const cap = {
  loops: 'maxLoops',
  searches: 'maxSearches',
  pages: 'maxPages',
} as const;

export function createGovernor(options: {
  limits?: ResearchLimits;
  quota?: Pick<QuotaMeter, 'snapshot'>;
  signal?: AbortSignal;
  priorUsage?: { tokens: number; llmCalls: number };
}) {
  let limits = options.limits ?? defaults.research;
  const started = performance.now();
  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([deadline.signal, options.signal])
    : deadline.signal;
  let timer: ReturnType<typeof setTimeout>;
  const elapsed = () => Math.max(0, Math.floor(performance.now() - started));
  const usage = {
    loops: 0,
    searches: 0,
    pages: 0,
    searchCreditsUsed: 0,
    tokensUsed: options.priorUsage?.tokens ?? 0,
    llmCalls: options.priorUsage?.llmCalls ?? 0,
  };
  let degraded = false;
  const blocks = new Set<ResearchReason>();

  function arm() {
    clearTimeout(timer);
    const remaining = limits.maxWallClockMs - elapsed();
    if (remaining <= 0) deadline.abort();
    else timer = setTimeout(() => deadline.abort(), remaining);
  }
  arm();

  function stopped() {
    if (!deadline.signal.aborted && elapsed() >= limits.maxWallClockMs)
      deadline.abort();
    return signal.aborted;
  }

  return {
    signal,
    get degraded() {
      return degraded;
    },
    get passages() {
      return limits.passages;
    },
    updateQuota() {
      if (degraded || !options.quota) return;
      let nearLimit: boolean;
      try {
        nearLimit = options.quota.snapshot().some((row) => row.nearLimit);
      } catch {
        return;
      }
      if (!nearLimit) return;
      degraded = true;
      limits = {
        ...limits,
        maxLoops: Math.min(limits.maxLoops, 1),
        maxSearches: Math.min(limits.maxSearches, 1),
        maxPages: Math.min(limits.maxPages, 1),
        maxSearchCredits: Math.min(limits.maxSearchCredits, 1),
      };
    },
    stopped,
    take(counter: Counter) {
      if (stopped()) return false;
      if (usage[counter] >= limits[cap[counter]]) {
        blocks.add(counter);
        return false;
      }
      usage[counter]++;
      return true;
    },
    reserveCredits(units: number) {
      if (stopped()) return;
      if (usage.searchCreditsUsed + units > limits.maxSearchCredits) {
        blocks.add('credits');
        return;
      }
      usage.searchCreditsUsed += units;
      return () => {
        usage.searchCreditsUsed -= units;
      };
    },
    tokenAllowance(estimatedInput: number, outputCap: number, reserved = 0) {
      if (stopped()) return 0;
      const allowance = Math.min(
        outputCap,
        limits.maxTokens - usage.tokensUsed - estimatedInput - reserved,
      );
      if (allowance < 64) {
        blocks.add('tokens');
        return 0;
      }
      return allowance;
    },
    account(stats: LLMStats | undefined, reservation: number) {
      const calls = stats?.calls ?? 1;
      usage.llmCalls += calls;
      if (!calls) return;
      const unreported =
        calls - (stats?.usageReports ?? 0) - (stats?.rateLimitedCalls ?? 0);
      const measured =
        (stats?.inputTokens ?? 0) +
        (stats?.outputTokens ?? 0) +
        reservation * Math.max(0, unreported);
      usage.tokensUsed += measured;
      if (usage.tokensUsed > limits.maxTokens) blocks.add('tokens');
    },
    blocked(reason: ResearchReason) {
      return blocks.has(reason);
    },
    reason(): ResearchReason | undefined {
      if (options.signal?.aborted) return 'aborted';
      if (stopped()) return 'wall_clock';
      return (
        ['tokens', 'credits', 'searches', 'pages', 'loops'] as const
      ).find((reason) => blocks.has(reason));
    },
    usage: () => ({ ...usage, elapsedMs: elapsed() }),
    close: () => clearTimeout(timer),
  };
}
export type Governor = ReturnType<typeof createGovernor>;
