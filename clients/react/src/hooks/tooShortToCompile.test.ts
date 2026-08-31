/**
 * The threshold reads the server-credited count, never the on-screen
 * clock. Wiring it the other way round is the bug: the clock interpolates
 * past 1:00 before that minute is a capture unit, so the warning would
 * stop appearing exactly when it's still true.
 */
import { describe, expect, it } from "vitest";
import { MIN_STOPPABLE_TRACKED_SECONDS } from "@lookout/shared";
import { isTooShortToCompile } from "./tooShortToCompile.js";

describe("isTooShortToCompile", () => {
  it("is true for a session with nothing credited", () => {
    expect(isTooShortToCompile(0)).toBe(true);
  });

  it("is true right up to the first credited minute", () => {
    expect(isTooShortToCompile(MIN_STOPPABLE_TRACKED_SECONDS - 1)).toBe(true);
  });

  it("is false from the first credited minute on", () => {
    expect(isTooShortToCompile(MIN_STOPPABLE_TRACKED_SECONDS)).toBe(false);
    expect(isTooShortToCompile(3600)).toBe(false);
  });
});
