import { describe, expect, it } from "vitest";
import { estimateBuildProgress } from "./buildProgress.js";

describe("estimateBuildProgress", () => {
  const estimate = 30_000;

  it("starts at zero and rises", () => {
    expect(estimateBuildProgress(0, estimate)).toBe(0);
    expect(estimateBuildProgress(5_000, estimate)).toBeGreaterThan(0);
  });

  it("is monotonic in elapsed time", () => {
    let prev = -1;
    for (let t = 0; t <= 120_000; t += 500) {
      const p = estimateBuildProgress(t, estimate);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("never reaches 1 — only the video actually landing ends the wait", () => {
    expect(estimateBuildProgress(estimate, estimate)).toBeLessThan(1);
    expect(estimateBuildProgress(10 * estimate, estimate)).toBeLessThan(1);
  });

  it("is anchored to elapsed time, so a re-render can't rewind it", () => {
    // The regression: the poll used to re-create its state object every
    // 1.5s, re-running the effect and resetting `startedAt` — the ring
    // walked 0 → 12% → 0 → 12% forever. Progress is a pure function of
    // elapsed time, so the same elapsed value always yields the same
    // number no matter how many times it's recomputed.
    const a = estimateBuildProgress(9_000, estimate);
    const b = estimateBuildProgress(9_000, estimate);
    expect(a).toBe(b);
    expect(estimateBuildProgress(10_500, estimate)).toBeGreaterThan(a);
  });

  it("scales with the amount of footage", () => {
    // A long recording should be less far along at the same wall-clock
    // moment than a short one.
    const short = estimateBuildProgress(20_000, 20_000);
    const long = estimateBuildProgress(20_000, 200_000);
    expect(long).toBeLessThan(short);
  });
});
