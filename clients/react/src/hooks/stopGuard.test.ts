/**
 * The Stop gate. What matters here is WHICH clock decides: the gate reads
 * the server-credited count and only the countdown reads the display
 * clock. Wiring it the other way round is the bug — the display clock
 * interpolates past 1:00 before the first minute is a capture unit, so a
 * stop taken on it compiles a single frozen still.
 */
import { describe, expect, it } from "vitest";
import { MIN_STOPPABLE_TRACKED_SECONDS } from "@lookout/shared";
import { stopGuard } from "./stopGuard.js";

describe("stopGuard", () => {
  it("holds Stop back for a session with nothing banked", () => {
    const { canStop, reason } = stopGuard(0, 0);
    expect(canStop).toBe(false);
    expect(reason).toContain("60s to go");
  });

  it("counts down on the display clock, which is the one that ticks", () => {
    // trackedSeconds is identical across all three — it steps 0 → 60 in a
    // single jump, so a countdown built on it would never move.
    expect(stopGuard(0, 10).reason).toContain("50s to go");
    expect(stopGuard(0, 30).reason).toContain("30s to go");
    expect(stopGuard(0, 59).reason).toContain("1s to go");
  });

  it("says it is waiting once the clock passes a minute but the credit hasn't landed", () => {
    // The confirm round trip. Still not stoppable, but "0s to go" would
    // read as broken.
    const { canStop, reason } = stopGuard(0, 63);
    expect(canStop).toBe(false);
    expect(reason).toBe("Saving the first minute — Stop unlocks once it lands.");
  });

  it("unlocks on the first credited minute", () => {
    expect(stopGuard(MIN_STOPPABLE_TRACKED_SECONDS, 61)).toEqual({
      canStop: true,
      reason: null,
    });
  });

  it("stays unlocked for the rest of the session", () => {
    expect(stopGuard(3600, 3605).canStop).toBe(true);
  });

  it("ignores a display clock that runs ahead of the credit", () => {
    // The exact gap this exists to close: 5 minutes on screen, nothing
    // credited (every capture landing outside the streak window).
    expect(stopGuard(0, 300).canStop).toBe(false);
  });
});
