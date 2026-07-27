/**
 * The seed capture must not become a video second.
 *
 * A session's first capture opens the recording rather than closing a
 * recorded minute: it credits 0 tracked seconds in both tracking modes, and
 * in clips mode its clip spans only the ~8s before the opening cut. Giving
 * it an equal one-second segment made the video one second longer than the
 * tracked minute count AND played the head of every timelapse at ~8x while
 * the rest ran at 60x.
 *
 * Pure row math — no ffmpeg, no DB.
 */
import { describe, expect, it } from "vitest";
import { dropSeedUnit } from "../src/segments.js";

/** Minimal stand-in for the compiler's `DISTINCT ON (minute_bucket)` rows,
 *  which arrive ordered by bucket ascending. */
const buckets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, minute_bucket: i }));

describe("seed unit exclusion", () => {
  it("drops the first unit so video seconds equal tracked minutes", () => {
    // The reported case: 2 captures, 60s apart. Bucket mode reports
    // (2 - 1) * 60 = 60s tracked, so the video must be 1 second, not 2.
    const kept = dropSeedUnit(buckets(2));
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("u1");
  });

  it("agrees with tracked minutes across session lengths", () => {
    for (const captures of [2, 3, 10, 61, 720]) {
      const trackedMinutes = (captures - 1) * 60 / 60;
      expect(dropSeedUnit(buckets(captures))).toHaveLength(trackedMinutes);
    }
  });

  it("keeps the only unit of a single-capture session", () => {
    // Tracked time is legitimately 0 here, but a zero-length video is worse
    // than an imprecise one — and an empty segment list fails the compile.
    expect(dropSeedUnit(buckets(1))).toHaveLength(1);
  });

  it("is a no-op on an empty list", () => {
    expect(dropSeedUnit([])).toEqual([]);
  });

  it("preserves order and identity of the surviving units", () => {
    // Array index == video second == the map the edit feature cuts against,
    // so the surviving rows must stay in bucket order.
    expect(dropSeedUnit(buckets(5)).map((r) => r.id)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
    ]);
  });
});
