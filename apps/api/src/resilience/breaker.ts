export function createBreaker(
  threshold: number,
  cooldownMs: number,
  now: () => number,
) {
  let failures = 0;
  let openUntil: number | undefined;
  let probeInFlight = false;
  let generation = 0;

  return {
    enter():
      | ((
          outcome: 'success' | 'failure' | 'neutral',
          retryAfterMs?: number,
        ) => void)
      | undefined {
      const probe = openUntil !== undefined;
      if (probe && (now() < openUntil! || probeInFlight)) return;
      if (probe) probeInFlight = true;
      const attemptGeneration = generation;

      return (outcome, retryAfterMs) => {
        if (attemptGeneration !== generation) return;
        if (probe) probeInFlight = false;
        if (outcome === 'success') {
          failures = 0;
          openUntil = undefined;
        } else if (
          outcome === 'failure' &&
          (probe || ++failures >= threshold || retryAfterMs !== undefined)
        ) {
          openUntil = now() + Math.max(cooldownMs, retryAfterMs ?? 0);
          generation++;
        }
      };
    },
  };
}
