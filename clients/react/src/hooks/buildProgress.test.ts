import { describe, expect, it } from "vitest";
import {
  estimateBuildProgress,
  interpolateBuildProgress,
  PROGRESS_POLL_MS,
  PROGRESS_CAP,
  COMPILE_MS_PER_UNIT,
} from "./buildProgress.js";

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

describe("interpolateBuildProgress", () => {
  const estimate = 30_000;

  it("keeps moving between polls instead of freezing", () => {
    // The bug: once real progress arrived the ring froze between polls, so it
    // went from five updates a second to one every two seconds and read as a
    // hang. Every 200ms tick must show movement.
    const a = interpolateBuildProgress(0.4, 0, estimate);
    const b = interpolateBuildProgress(0.4, 200, estimate);
    const c = interpolateBuildProgress(0.4, 400, estimate);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("never advances more than one poll interval is expected to deliver", () => {
    // Honesty bound: if the worker stalls, the ring eases to just short of the
    // next anchor and holds — it can't sail to the cap while nothing happens.
    const budget = PROGRESS_POLL_MS / estimate;
    for (const stalled of [2_000, 10_000, 60_000, 600_000]) {
      const p = interpolateBuildProgress(0.4, stalled, estimate);
      expect(p).toBeLessThanOrEqual(0.4 + budget + 1e-9);
    }
  });

  it("holds rather than inflating on a long stall", () => {
    const at10s = interpolateBuildProgress(0.4, 10_000, estimate);
    const at10m = interpolateBuildProgress(0.4, 600_000, estimate);
    expect(at10m - at10s).toBeLessThan(0.001);
  });

  it("never passes the cap, however late the anchor is", () => {
    expect(interpolateBuildProgress(PROGRESS_CAP, 600_000, estimate)).toBe(PROGRESS_CAP);
    expect(interpolateBuildProgress(0.99, 600_000, estimate)).toBeLessThanOrEqual(PROGRESS_CAP);
    expect(interpolateBuildProgress(0.94, 600_000, estimate)).toBeLessThanOrEqual(PROGRESS_CAP);
  });

  it("starts exactly at the anchor, so a new real value never rewinds it", () => {
    expect(interpolateBuildProgress(0.62, 0, estimate)).toBeCloseTo(0.62, 10);
  });

  it("moves more slowly for a longer compile", () => {
    // A poll interval is a smaller share of a long build, so the same 200ms
    // should carry the ring less far.
    const short = interpolateBuildProgress(0.4, 200, 10_000);
    const long = interpolateBuildProgress(0.4, 200, 300_000);
    expect(long).toBeLessThan(short);
  });

  it("clamps a nonsensical anchor rather than propagating it", () => {
    expect(interpolateBuildProgress(-1, 1_000, estimate)).toBeGreaterThanOrEqual(0);
    expect(interpolateBuildProgress(5, 1_000, estimate)).toBeLessThanOrEqual(PROGRESS_CAP);
  });
});

/**
 * The two sources together — the property the user actually experiences.
 * Neither source may silence the other: the estimate guarantees the ring is
 * always moving, real progress guarantees it stays tied to the truth.
 */
describe("the ring never stalls and never lies", () => {
  const estimateMs = 6_000 + 120 * COMPILE_MS_PER_UNIT;
  /** Mirrors the editor's tick. */
  const display = (
    prev: number,
    elapsedMs: number,
    anchor: { value: number; atMs: number } | null,
    nowMs: number,
  ) =>
    Math.min(
      PROGRESS_CAP,
      Math.max(
        prev,
        estimateBuildProgress(elapsedMs, estimateMs),
        anchor ? interpolateBuildProgress(anchor.value, nowMs - anchor.atMs, estimateMs) : 0,
      ),
    );

  it("moves on EVERY tick, even while real progress is stuck behind", () => {
    // The failure mode: real progress lands below the estimate, and a
    // ring driven only by the anchor would sit frozen until real caught up.
    let prev = 0;
    const anchor = { value: 0.02, atMs: 0 };
    let stalls = 0;
    for (let t = 200; t <= 8_000; t += 200) {
      const next = display(prev, t, anchor, t);
      if (next <= prev) stalls++;
      prev = next;
    }
    expect(stalls).toBe(0);
  });

  it("is pulled up by real progress when the worker is ahead of the guess", () => {
    const early = 1_000;
    const withoutReal = display(0, early, null, early);
    const withReal = display(0, early, { value: 0.7, atMs: early }, early);
    expect(withReal).toBeGreaterThan(withoutReal);
    expect(withReal).toBeCloseTo(0.7, 2);
  });

  it("is monotonic across a full wait, whatever the sources do", () => {
    let prev = 0;
    let anchor: { value: number; atMs: number } | null = null;
    for (let t = 0; t <= 40_000; t += 200) {
      // Real progress arrives every 2s, jitters, and even regresses once.
      if (t > 0 && t % 2_000 === 0) {
        const v = t === 10_000 ? 0.1 : Math.min(0.95, (t / 40_000) * 0.95);
        anchor = { value: v, atMs: t };
      }
      const next = display(prev, t, anchor, t);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });

  it("never shows a full ring while the user is still waiting", () => {
    const late = display(0.94, 10 * 60_000, { value: 0.95, atMs: 0 }, 10 * 60_000);
    expect(late).toBeLessThanOrEqual(PROGRESS_CAP);
    expect(late).toBeLessThan(1);
  });
});
