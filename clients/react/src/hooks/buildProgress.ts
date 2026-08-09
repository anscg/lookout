/** Fixed cost of a compile: claim, sampling query, assembly, upload. */
export const COMPILE_BASE_MS = 6_000;

/** Marginal cost per capture unit (download + a 1s segment encode, across
 *  the worker's 8-way pool). Only used to size the estimate below. */
export const COMPILE_MS_PER_UNIT = 350;

/** How long a compile of `units` minutes of footage is expected to take. */
export function compileEstimateMs(units: number): number {
  return COMPILE_BASE_MS + Math.max(0, units) * COMPILE_MS_PER_UNIT;
}

/**
 * Progress of the preview build, as a pure function of elapsed time.
 *
 * The worker reports no real progress, so this is an estimate — which
 * makes two properties non-negotiable, and both come from being pure:
 *
 *  - **Monotonic.** Progress that walks backwards reads as a broken build
 *    even when the work is fine. Depending only on elapsed time means a
 *    re-render can't rewind it (the original bug: a polling effect
 *    re-created its state object every 1.5s, resetting the anchor, so the
 *    ring cycled 0 → 12% → 0 forever).
 *  - **Never completes.** It approaches 1 asymptotically and only the
 *    video actually landing ends the wait, so the ring can't sit at 100%
 *    while the user is still waiting.
 */
export function estimateBuildProgress(elapsedMs: number, estimateMs: number): number {
  if (estimateMs <= 0) return 0;
  return 1 - Math.exp(-2.2 * (Math.max(0, elapsedMs) / estimateMs));
}
