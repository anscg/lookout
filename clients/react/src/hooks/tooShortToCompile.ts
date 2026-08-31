import { MIN_STOPPABLE_TRACKED_SECONDS } from "@lookout/shared";

/**
 * Whether stopping now would produce no timelapse.
 *
 * Under one capture unit there is nothing for the compile to work with:
 * the seed capture opens the recording rather than closing a minute, so
 * the worker drops it, and the only other thing a sub-minute session
 * holds is the still the client flushes on the way out.
 *
 * This gates COPY, not the Stop button. Someone who opened a session by
 * mistake is entitled to leave, and a greyed-out exit with a paragraph
 * next to it is a worse answer than letting them click and saying, once,
 * at the moment it matters, that there's nothing to save.
 *
 * Read the SERVER-credited count, never the on-screen clock: the clock
 * interpolates between confirms, so it passes 1:00 a round trip before
 * that minute exists as a capture unit.
 */
export function isTooShortToCompile(trackedSeconds: number): boolean {
  return trackedSeconds < MIN_STOPPABLE_TRACKED_SECONDS;
}
