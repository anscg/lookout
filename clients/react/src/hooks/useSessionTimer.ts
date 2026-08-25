import { useState, useEffect, useRef } from "react";
import {
  SCREENSHOT_INTERVAL_MS,
  TIMER_INTERPOLATION_SLACK_S,
} from "@lookout/shared";

/** Max seconds the display may drift ahead of `serverTrackedSeconds`
 *  between credits: one capture interval plus latency slack. If captures
 *  stall, the freeze stays put so the user sees something is wrong
 *  instead of an inflated count.
 *
 *  The slack exists because credits are earned on the 60s streak grid but
 *  arrive a confirm round-trip later, and clip uploads make that latency
 *  jitter by seconds. Capped at exactly one interval, the display froze at
 *  every xx:00 boundary whenever two confirms arrived more than 60s apart
 *  (the credited base is always a multiple of 60) — users read the stutter
 *  as the recorder breaking. See TIMER_INTERPOLATION_SLACK_S. */
export const MAX_INTERPOLATION_S =
  Math.floor(SCREENSHOT_INTERVAL_MS / 1000) + TIMER_INTERPOLATION_SLACK_S;

/**
 * The timer's anchor state, for surfaces that tick their own clock
 * instead of consuming `displaySeconds` (the desktop menu-bar ticker in
 * Rust, and the tray popup window).
 *
 * Those surfaces MUST reproduce the same three rules or they drift out
 * of sync with the main window — which is exactly the "menu bar shows a
 * different time" bug:
 *
 *   1. display = `baseSeconds` + min(MAX_INTERPOLATION_S, now - `anchorAt`)
 *   2. while not active (paused/stopped), display = `baseSeconds` — the
 *      interpolated remainder is dropped, not frozen
 *   3. `baseSeconds` ratchets forward only, and `anchorAt` resets only
 *      when it actually advances
 *
 * Never re-interpolate from `displaySeconds`: it already contains the
 * interpolated remainder, so extrapolating from it double-counts.
 */
export interface SessionTimerState {
  /** What to render. */
  displaySeconds: number;
  /** Ratcheted server-authoritative value the display is anchored to. */
  baseSeconds: number;
  /** `Date.now()` when `baseSeconds` last advanced. */
  anchorAt: number;
}

/**
 * The one implementation of rules 1 and 2 above. Every JS surface that
 * renders the recording clock goes through this — the main window via
 * `useSessionTimerState`, the desktop tray popup from the anchor it
 * receives over IPC. (The Rust menu-bar ticker mirrors it in
 * `tray_timer_task`; keep the two in step.)
 */
export function deriveDisplaySeconds(
  baseSeconds: number,
  anchorAt: number,
  isActive: boolean,
  now: number,
): number {
  if (!isActive) return baseSeconds;
  const elapsed = Math.floor((now - anchorAt) / 1000);
  return baseSeconds + Math.min(MAX_INTERPOLATION_S, Math.max(0, elapsed));
}

/**
 * Display timer for the recording session.
 *
 * `serverTrackedSeconds` is the ground truth. We interpolate at
 * wall-clock rate between credits for liveness, but the interpolation
 * is **capped at one capture interval plus latency slack**
 * (MAX_INTERPOLATION_S). Display never overshoots the next credit by
 * more than that, so stop/compile reveals at most about a minute of
 * drop — no "halving" surprise.
 *
 * `baseRef` ratchets forward (never backward) so a stale-read
 * idempotent retry returning a lower `trackedSeconds` doesn't cause
 * the display to jump back. With the cap, ratcheting can only get the
 * display 60s ahead of the true value, bounded.
 *
 * Unfreeze contract: when `serverTrackedSeconds` advances, `baseRef`
 * ratchets up and `lastSyncRef` resets — display jumps to the new
 * value and the next interpolation cycle starts from there.
 */
export function useSessionTimerState(
  serverTrackedSeconds: number,
  isActive: boolean,
  /**
   * When set (ms epoch), the clock is FROZEN at that instant: the pause/stop
   * button was clicked, and the user expects the timer to stop right then —
   * not to keep ticking through the flush + pause round trip, and not to
   * snap anywhere. Everything below computes with `min(now, holdAtMs)`, so
   * the display holds at the clicked value while the final capture's credit
   * ratchets the base up to (approximately) that same number underneath;
   * the eventual paused snap then lands where the clock already is. Cleared
   * on resume (or on a failed pause, where the clock catches back up).
   */
  holdAtMs?: number | null,
): SessionTimerState {
  const [displaySeconds, setDisplaySeconds] = useState(serverTrackedSeconds);
  const lastSyncRef = useRef(Date.now());
  const baseRef = useRef(serverTrackedSeconds);
  // Read by the ratchet effect below; a credit landing while paused must
  // not manufacture carry out of a display that isn't interpolating.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const holdAtRef = useRef<number | null>(holdAtMs ?? null);
  holdAtRef.current = holdAtMs ?? null;
  /** The clock's "now": wall clock, stopped at the hold instant when held. */
  const clockNow = () => {
    const hold = holdAtRef.current;
    const now = Date.now();
    return hold != null ? Math.min(now, hold) : now;
  };

  // Ratchet baseRef forward on every server update, re-anchoring the
  // interpolation window — this is what unfreezes the timer.
  //
  // THE DISPLAY NEVER MOVES BACKWARD HERE. Credits are earned on the 60s
  // grid but arrive a confirm round-trip later, and the interpolation slack
  // lets the clock tick a few seconds past the pending credit while it's in
  // flight. Snapping to the bare server value on arrival made the clock
  // visibly jump BACK by the confirm latency at the first credit of every
  // session and resume (0:00→1:05, then "reset" to 1:00). Instead, any
  // overshoot is folded into the anchor as carry: the clock continues from
  // where it was, and the credited base catches up underneath. The carry is
  // bounded by the interpolation cap by construction, self-corrects as
  // latency shrinks, and is dropped (never banked) on pause — rule 2 still
  // snaps to the ratcheted base.
  useEffect(() => {
    const newBase = Math.max(baseRef.current, serverTrackedSeconds);
    if (newBase !== baseRef.current) {
      // The clock's frozen "now" while held, so the flush credit landing
      // mid-hold reconciles against the value the user is looking at and
      // the display stays put.
      const now = clockNow();
      const shown = deriveDisplaySeconds(
        baseRef.current,
        lastSyncRef.current,
        isActiveRef.current,
        now,
      );
      // Capped at the slack: carry exists to absorb confirm LATENCY, and
      // latency can't legitimately exceed the slack allowance. Without the
      // cap, a long freeze followed by a small partial credit would let the
      // display run most of a minute ahead of the credited truth.
      const carryS = Math.min(
        Math.max(0, shown - newBase),
        TIMER_INTERPOLATION_SLACK_S,
      );
      baseRef.current = newBase;
      lastSyncRef.current = now - carryS * 1000;
      setDisplaySeconds(newBase + carryS);
    }
  }, [serverTrackedSeconds]);

  useEffect(() => {
    // When the session leaves active (pause/stop), snap display to the
    // ratcheted base. No further interpolation. Worst-case drop the user
    // sees is bounded by MAX_INTERPOLATION_S (cap above).
    if (!isActive) {
      setDisplaySeconds(baseRef.current);
      return;
    }

    lastSyncRef.current = Date.now();

    let raf: number;
    let lastRendered = -1;
    const tick = () => {
      const next = deriveDisplaySeconds(
        baseRef.current,
        lastSyncRef.current,
        true,
        clockNow(),
      );
      if (next !== lastRendered) {
        lastRendered = next;
        setDisplaySeconds(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Don't bake elapsed into baseRef here. If we did, baseRef would
      // grow past the server's true value during pauses or stalls, and
      // the next server update couldn't ratchet forward (max() would
      // keep the inflated baseRef). Server credits after resume re-anchor
      // baseRef via the sync effect above.
    };
    // `serverTrackedSeconds` is deliberately NOT a dep. The tick reads
    // baseRef/lastSyncRef live, and the sync effect above already
    // re-anchors on advance. Including it here re-ran this effect on
    // every server response and reset `lastSyncRef` even when the value
    // did NOT advance (a repeated or lower reading), silently discarding
    // up to a minute of interpolation that the other surfaces kept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return {
    displaySeconds,
    baseSeconds: baseRef.current,
    anchorAt: lastSyncRef.current,
  };
}

/** Convenience wrapper: just the number to render. */
export function useSessionTimer(
  serverTrackedSeconds: number,
  isActive: boolean,
  holdAtMs?: number | null,
): number {
  return useSessionTimerState(serverTrackedSeconds, isActive, holdAtMs)
    .displaySeconds;
}

/** Format seconds as H:MM:SS or M:SS (for live timer display). */
export function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Format seconds as human-readable tracked time (e.g. "1h 34min", "12min", "< 1min"). */
export function formatTrackedTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}min`;
  return "< 1min";
}
