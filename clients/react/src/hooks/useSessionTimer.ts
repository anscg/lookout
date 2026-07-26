import { useState, useEffect, useRef } from "react";
import { SCREENSHOT_INTERVAL_MS } from "@lookout/shared";

/** Max seconds the display may drift ahead of `serverTrackedSeconds`
 *  between credits. One capture interval — if the next capture credits,
 *  the display jumps to the new server value (== frozen value) and
 *  unfreezes smoothly. If captures stall, the freeze stays put so the
 *  user sees something is wrong instead of an inflated count. */
export const MAX_INTERPOLATION_S = Math.floor(SCREENSHOT_INTERVAL_MS / 1000);

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
 * is **capped at one capture interval**. Display never overshoots the
 * next credit by more than that, so stop/compile reveals at most one
 * minute of drop — no "halving" surprise.
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
): SessionTimerState {
  const [displaySeconds, setDisplaySeconds] = useState(serverTrackedSeconds);
  const lastSyncRef = useRef(Date.now());
  const baseRef = useRef(serverTrackedSeconds);

  // Ratchet baseRef forward on every server update. Resets the
  // interpolation anchor — this is what unfreezes the timer.
  useEffect(() => {
    const newBase = Math.max(baseRef.current, serverTrackedSeconds);
    if (newBase !== baseRef.current) {
      baseRef.current = newBase;
      setDisplaySeconds(newBase);
      lastSyncRef.current = Date.now();
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
        Date.now(),
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
): number {
  return useSessionTimerState(serverTrackedSeconds, isActive).displaySeconds;
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
