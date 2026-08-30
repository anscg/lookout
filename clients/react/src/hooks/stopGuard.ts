import { MIN_STOPPABLE_TRACKED_SECONDS } from "@lookout/shared";

/**
 * Whether a recording is far enough along to be worth stopping, and what
 * to tell the user when it isn't.
 *
 * A session under one capture unit compiles to a single frozen frame at
 * best (see MIN_STOPPABLE_TRACKED_SECONDS), so every client holds Stop
 * back until the first minute is banked. This is the one definition all
 * of them share — the web/hosted recorder through `RecordingControls`,
 * the desktop app through its own controls and its tray menu.
 *
 * The gate reads the SERVER-credited count, not the on-screen clock. The
 * clock interpolates between confirms, so it passes 1:00 a round trip
 * before the minute it's counting actually exists as a capture unit; a
 * stop in that gap is exactly the empty compile this guards against. The
 * clock is still the better thing to COUNT DOWN with, because
 * `trackedSeconds` steps 0 → 60 in one jump and a countdown built on it
 * would sit frozen at "1:00 to go" for the whole minute. So: gate on the
 * server, narrate with the clock, and cover the gap between them with a
 * separate message rather than a countdown that has already hit zero.
 */
export interface StopGuard {
  /** False while Stop should be refused. */
  canStop: boolean;
  /** Why Stop is held back, or null once it isn't. */
  reason: string | null;
}

export function stopGuard(
  trackedSeconds: number,
  displaySeconds: number,
): StopGuard {
  if (trackedSeconds >= MIN_STOPPABLE_TRACKED_SECONDS) {
    return { canStop: true, reason: null };
  }
  const remaining = Math.max(
    0,
    MIN_STOPPABLE_TRACKED_SECONDS - Math.floor(displaySeconds),
  );
  return {
    canStop: false,
    reason: remaining
      ? `Record for at least a minute before stopping — ${remaining}s to go.`
      : "Saving the first minute — Stop unlocks once it lands.",
  };
}
