/**
 * Pure unit tests for the shared cut-list semantics (@lookout/shared
 * cuts.ts) — the single membership/normalization/tracked-time
 * implementation used by the server routes, the worker's cut-compile, and
 * the React editor. No DB required.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeCuts,
  isCutAt,
  computeKeptRanges,
  countCutUnits,
  computeCutSeconds,
  MAX_CUT_INTERVALS,
  type CutInterval,
  type CaptureRowForCuts,
} from "@lookout/shared";

const T0 = Date.parse("2026-07-01T10:00:00.000Z");
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();
const cut = (a: number, b: number): CutInterval => ({ start: iso(a), end: iso(b) });

describe("normalizeCuts", () => {
  it("accepts an empty list", () => {
    const r = normalizeCuts([]);
    expect(r).toEqual({ ok: true, cuts: [] });
  });

  it("rejects non-arrays and malformed entries", () => {
    expect(normalizeCuts("nope").ok).toBe(false);
    expect(normalizeCuts([{ start: 5, end: 6 }]).ok).toBe(false);
    expect(normalizeCuts([{ start: "not a date", end: iso(1) }]).ok).toBe(false);
  });

  it("rejects end <= start", () => {
    expect(normalizeCuts([cut(5, 5)]).ok).toBe(false);
    expect(normalizeCuts([cut(6, 5)]).ok).toBe(false);
  });

  it("rejects lists over the interval cap", () => {
    const many = Array.from({ length: MAX_CUT_INTERVALS + 1 }, (_, i) =>
      cut(i * 2, i * 2 + 1),
    );
    expect(normalizeCuts(many).ok).toBe(false);
  });

  it("sorts and merges overlapping and adjacent intervals", () => {
    const r = normalizeCuts([cut(10, 15), cut(3, 6), cut(14, 20), cut(6, 8)]);
    expect(r).toEqual({
      ok: true,
      cuts: [cut(3, 8), cut(10, 20)],
    });
  });

  it("clamps to the session envelope and drops fully-outside intervals", () => {
    const bounds = { minMs: T0, maxMs: T0 + 30 * 60_000 };
    const r = normalizeCuts([cut(-30, 5), cut(50, 60)], bounds);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cuts).toHaveLength(1);
      // Clamped to minMs − 5min slack.
      expect(Date.parse(r.cuts[0].start)).toBe(T0 - 5 * 60_000);
      expect(r.cuts[0].end).toBe(iso(5));
    }
  });
});

describe("isCutAt", () => {
  const cuts = [cut(5, 10)];
  it("is end-exclusive, start-inclusive", () => {
    expect(isCutAt(T0 + 5 * 60_000, cuts)).toBe(true);
    expect(isCutAt(T0 + 10 * 60_000 - 1, cuts)).toBe(true);
    expect(isCutAt(T0 + 10 * 60_000, cuts)).toBe(false);
    expect(isCutAt(T0 + 4 * 60_000, cuts)).toBe(false);
  });
});

describe("computeKeptRanges", () => {
  // 10 units captured one per minute.
  const unitTimes = Array.from({ length: 10 }, (_, i) => T0 + i * 60_000);

  it("keeps everything with no cuts", () => {
    expect(computeKeptRanges(unitTimes, [])).toEqual([{ start: 0, end: 10 }]);
  });

  it("splits around a middle cut", () => {
    // Cut minutes 3..5 (units 3, 4).
    expect(computeKeptRanges(unitTimes, [cut(3, 5)])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 10 },
    ]);
  });

  it("handles cuts at the ends and multiple regions", () => {
    expect(
      computeKeptRanges(unitTimes, [cut(0, 2), cut(4, 5), cut(8, 60)]),
    ).toEqual([
      { start: 2, end: 4 },
      { start: 5, end: 8 },
    ]);
  });

  it("returns [] when everything is cut", () => {
    expect(computeKeptRanges(unitTimes, [cut(0, 60)])).toEqual([]);
  });

  it("counts cut units consistently", () => {
    expect(countCutUnits(unitTimes, [cut(3, 5)])).toBe(2);
  });
});

describe("computeCutSeconds", () => {
  const rows: CaptureRowForCuts[] = Array.from({ length: 10 }, (_, i) => ({
    timeMs: T0 + i * 60_000,
    creditedSeconds: i === 0 ? 0 : 60, // seed capture credits 0, like real streaks
    minuteBucket: i,
  }));
  const rawCredit = rows.reduce((n, r) => n + (r.creditedSeconds ?? 0), 0); // 540

  it("returns 0 for no cuts", () => {
    expect(computeCutSeconds(rows, "credit", rawCredit, [])).toBe(0);
  });

  it("credit mode sums credited seconds of cut rows", () => {
    // Cut minutes 3..5 → units 3 and 4, each credited 60.
    expect(computeCutSeconds(rows, "credit", rawCredit, [cut(3, 5)])).toBe(120);
    // Cutting the 0-credit seed removes nothing.
    expect(computeCutSeconds(rows, "credit", rawCredit, [cut(0, 1)])).toBe(0);
  });

  it("bucket mode mirrors the (buckets − 1) × 60 formula", () => {
    const rawBucket = (10 - 1) * 60; // 540
    // Cutting 2 buckets leaves 8 → kept = 7 × 60 = 420 → cut = 120.
    expect(computeCutSeconds(rows, "bucket", rawBucket, [cut(3, 5)])).toBe(120);
    // Empty cut list must be exactly 0 (kept formula matches raw).
    expect(computeCutSeconds(rows, "bucket", rawBucket, [])).toBe(0);
  });

  it("never exceeds the raw tracked value", () => {
    expect(
      computeCutSeconds(rows, "credit", 60, [cut(0, 60)]),
    ).toBeLessThanOrEqual(60);
  });
});
