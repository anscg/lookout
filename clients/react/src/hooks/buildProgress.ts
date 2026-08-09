/** Fixed cost of a compile: claim, sampling query, assembly, upload. */
export const COMPILE_BASE_MS = 6_000;

/** Marginal cost per capture unit (download + a 1s segment encode, across
 *  the worker's 8-way pool). Only used to size the estimate below.
 *
 *  Was 350, calibrated against the single-pass full-quality compile. The
 *  editor now waits on the PREVIEW tier, measured at ~83ms of encode per unit
 *  against ~431ms for the publish tier — so across an 8-way pool the marginal
 *  wall-clock cost is tens of milliseconds, dominated by the R2 fetch rather
 *  than ffmpeg. Leaving it at 350 made the estimate ~4x too slow, so real
 *  worker progress immediately overtook it and the ring inherited the poll's
 *  2-second granularity for the whole wait. */
export const COMPILE_MS_PER_UNIT = 90;

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

/** How often the editor polls `/status` for real progress. */
export const PROGRESS_POLL_MS = 2_000;

/** Ceiling on reported progress. Mirrors the worker's PROGRESS_UNIT_CAP: the
 *  unit loop is the only metered stage, so assembly, thumbnail and upload
 *  still run after it finishes. Only the status flip ends the wait. */
export const PROGRESS_CAP = 0.95;

/**
 * Progress BETWEEN real worker updates.
 *
 * Real progress arrives once per `/status` poll — every 2s, and only when the
 * worker has moved a further 1% — so using it directly makes the number lurch
 * in coarse steps with long dead pauses. Freezing the estimate the moment the
 * first real value lands (the original behaviour) was worse still: the ring
 * went from updating five times a second to once every two seconds, which read
 * as the whole editor hanging.
 *
 * So a real value becomes an ANCHOR and this eases forward from it, with two
 * bounds that keep it honest:
 *
 *  - It may only advance by as much as one poll interval is expected to
 *    deliver. If the worker stalls, the number eases up to just short of the
 *    next anchor and HOLDS there — it can't sail off to the cap while nothing
 *    is happening.
 *  - It never passes PROGRESS_CAP.
 *
 * Same shape as useSessionTimer's interpolation between server credits, and
 * for the same reason: a value that only moves when the network says so looks
 * broken, and a value that runs ahead of the truth lies.
 */
export function interpolateBuildProgress(
  anchor: number,
  sinceAnchorMs: number,
  estimateMs: number,
): number {
  const from = Math.max(0, Math.min(PROGRESS_CAP, anchor));
  if (estimateMs <= 0) return from;
  // What one poll interval's worth of work is expected to be, as a fraction
  // of the whole compile — and never more headroom than remains.
  const budget = Math.min(PROGRESS_CAP - from, PROGRESS_POLL_MS / estimateMs);
  if (budget <= 0) return from;
  const eased = 1 - Math.exp(-2.2 * (Math.max(0, sinceAnchorMs) / PROGRESS_POLL_MS));
  return Math.min(PROGRESS_CAP, from + budget * eased);
}
