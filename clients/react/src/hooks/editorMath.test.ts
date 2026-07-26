import { describe, expect, it } from "vitest";
import { countCutUnits, type CutInterval, type VideoUnit } from "@lookout/shared";
import {
  regionsToCuts,
  cutsToRegions,
  normalizeRegions,
  cutUnitCount,
  unitIsCut,
  regionAtTime,
  gapIndices,
  elapsedLabel,
  rulerStep,
  rulerTicks,
  formatUnitsDuration,
  type UnitRegion,
} from "./editorMath.js";

const T0 = Date.parse("2026-07-01T10:00:00.000Z");

/** n units captured a minute apart, with optional pause gaps: `gapsAfter`
 *  maps unit index → extra minutes of silence before the NEXT unit. */
function makeUnits(n: number, gapsAfter: Record<number, number> = {}): VideoUnit[] {
  const units: VideoUnit[] = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    units.push({
      capturedAt: new Date(t).toISOString(),
      screenshotId: `ss-${i}`,
    });
    t += 60_000 + (gapsAfter[i] ?? 0) * 60_000;
  }
  return units;
}

describe("regionsToCuts ⇄ cutsToRegions round-trip", () => {
  it("round-trips a middle region", () => {
    const units = makeUnits(10);
    const regions: UnitRegion[] = [{ startUnit: 3, endUnit: 6 }];
    const cuts = regionsToCuts(regions, units);
    expect(cutsToRegions(cuts, units)).toEqual(regions);
  });

  it("round-trips edge regions and multiple regions", () => {
    const units = makeUnits(12);
    const regions: UnitRegion[] = [
      { startUnit: 0, endUnit: 2 },
      { startUnit: 5, endUnit: 6 },
      { startUnit: 9, endUnit: 12 },
    ];
    expect(cutsToRegions(regionsToCuts(regions, units), units)).toEqual(regions);
  });

  it("round-trips across pause gaps without swallowing neighbors", () => {
    // A 3-hour pause between units 4 and 5: the wall-clock interval for a
    // region ending at unit 4 must not extend into unit 5's minute.
    const units = makeUnits(10, { 4: 180 });
    const regions: UnitRegion[] = [{ startUnit: 3, endUnit: 5 }];
    const cuts = regionsToCuts(regions, units);
    expect(cutsToRegions(cuts, units)).toEqual(regions);
    expect(unitIsCut(5, cutsToRegions(cuts, units))).toBe(false);
  });

  it("serializes a region as [firstCutUnit, firstKeptUnit)", () => {
    const units = makeUnits(5);
    const cuts = regionsToCuts([{ startUnit: 1, endUnit: 3 }], units);
    // End is exclusive and anchored to the next kept capture, so that
    // capture is excluded exactly regardless of the gap before it. On an
    // even 60s cadence that coincides with lastCut + 60s.
    expect(cuts).toEqual<CutInterval[]>([
      { start: units[1].capturedAt, end: units[3].capturedAt },
    ]);
  });

  it("drops empty regions", () => {
    const units = makeUnits(5);
    expect(regionsToCuts([{ startUnit: 2, endUnit: 2 }], units)).toEqual([]);
  });
});

describe("regionsToCuts agrees with the server's membership rule", () => {
  /** Server-side count: timestamp membership over the serialized list. */
  const serverCutCount = (units: VideoUnit[], cuts: CutInterval[]) =>
    countCutUnits(units.map((u) => Date.parse(u.capturedAt)), cuts);

  it("does not over-cut when captures arrive early", () => {
    // The reported bug: a 3-minute timelapse with 2 minutes selected was
    // rejected as "would remove the entire timelapse". Captures jitter
    // (the server credits anything within ±30s of the mark), so a 57s gap
    // put the next capture inside an interval that assumed a 60s stride.
    const T = Date.parse("2026-07-27T14:58:00.000Z");
    const units: VideoUnit[] = [
      { capturedAt: new Date(T).toISOString(), screenshotId: "a" },
      { capturedAt: new Date(T + 57_000).toISOString(), screenshotId: "b" },
      { capturedAt: new Date(T + 114_000).toISOString(), screenshotId: "c" },
    ];
    const cuts = regionsToCuts([{ startUnit: 0, endUnit: 2 }], units);
    expect(serverCutCount(units, cuts)).toBe(2);
    expect(cutsToRegions(cuts, units)).toEqual([{ startUnit: 0, endUnit: 2 }]);
  });

  it("holds across a spread of realistic jitter", () => {
    for (const gap of [40_000, 52_000, 57_000, 59_999, 60_000, 63_000, 75_000]) {
      const T = Date.parse("2026-07-27T09:00:00.000Z");
      const units: VideoUnit[] = Array.from({ length: 6 }, (_, i) => ({
        capturedAt: new Date(T + i * gap).toISOString(),
        screenshotId: `u${i}`,
      }));
      for (const region of [
        { startUnit: 0, endUnit: 2 },
        { startUnit: 2, endUnit: 4 },
        { startUnit: 4, endUnit: 6 },
      ]) {
        const cuts = regionsToCuts([region], units);
        expect(serverCutCount(units, cuts)).toBe(region.endUnit - region.startUnit);
      }
    }
  });

  it("never swallows more than an interval across a pause", () => {
    // Anchoring to the next kept capture must not extend a cut across a
    // three-hour pause and remove captures that live inside it.
    const units = makeUnits(6, { 2: 180 });
    const cuts = regionsToCuts([{ startUnit: 1, endUnit: 3 }], units);
    const span = Date.parse(cuts[0].end) - Date.parse(units[2].capturedAt);
    expect(span).toBeLessThanOrEqual(60_000);
    expect(serverCutCount(units, cuts)).toBe(2);
  });

  it("agrees for a cut running to the very end", () => {
    const units = makeUnits(5);
    const cuts = regionsToCuts([{ startUnit: 3, endUnit: 5 }], units);
    expect(serverCutCount(units, cuts)).toBe(2);
  });
});

describe("normalizeRegions", () => {
  it("merges overlapping and adjacent regions, sorts, drops empties", () => {
    expect(
      normalizeRegions([
        { startUnit: 6, endUnit: 8 },
        { startUnit: 1, endUnit: 3 },
        { startUnit: 3, endUnit: 5 },
        { startUnit: 4, endUnit: 4 },
      ]),
    ).toEqual([
      { startUnit: 1, endUnit: 5 },
      { startUnit: 6, endUnit: 8 },
    ]);
  });

  it("counts cut units", () => {
    expect(
      cutUnitCount([
        { startUnit: 1, endUnit: 5 },
        { startUnit: 6, endUnit: 8 },
      ]),
    ).toBe(6);
  });
});

describe("regionAtTime", () => {
  const regions: UnitRegion[] = [{ startUnit: 2, endUnit: 4 }];
  it("hits inside, misses outside (end-exclusive)", () => {
    expect(regionAtTime(2, regions)).toEqual(regions[0]);
    expect(regionAtTime(3.99, regions)).toEqual(regions[0]);
    expect(regionAtTime(4, regions)).toBeNull();
    expect(regionAtTime(1.5, regions)).toBeNull();
  });
});

describe("gapIndices", () => {
  it("flags pauses, ignores normal cadence and jitter", () => {
    const units = makeUnits(8, { 2: 30, 5: 5 });
    expect(gapIndices(units)).toEqual([3, 6]);
  });

  it("tolerates ±30s scheduling jitter", () => {
    const units = makeUnits(3);
    // 80s between captures is within 1.5× the interval — not a pause.
    units[2] = {
      ...units[2],
      capturedAt: new Date(Date.parse(units[1].capturedAt) + 80_000).toISOString(),
    };
    expect(gapIndices(units)).toEqual([]);
  });
});

describe("elapsedLabel", () => {
  it("is never mistakable for a duration in the wrong unit", () => {
    // The bug this replaced: a 17-minute timelapse labelled with wall
    // clock ("1:29" … "1:45") is correct but reads as 1m29s, making the
    // whole timeline look broken. Short sessions get an explicit unit.
    expect(elapsedLabel(0, 17)).toBe("0m");
    expect(elapsedLabel(5, 17)).toBe("5m");
    expect(elapsedLabel(16, 17)).toBe("16m");
  });

  it("switches to hours:minutes once minutes stop being readable", () => {
    expect(elapsedLabel(0, 180)).toBe("0:00");
    expect(elapsedLabel(65, 180)).toBe("1:05");
    expect(elapsedLabel(120, 180)).toBe("2:00");
  });

  it("rounds half-step tick positions to whole minutes", () => {
    expect(elapsedLabel(7.5, 17)).toBe("8m");
  });
});

describe("rulerStep", () => {
  it("picks a step people read without arithmetic", () => {
    // 48 minutes across 900px → ~19px/min; a label needs ~88px, so ~5min.
    expect(rulerStep(48, 900)).toBe(5);
    // The same recording in a narrow window steps up rather than crowding.
    expect(rulerStep(48, 300)).toBeGreaterThan(rulerStep(48, 900));
    // A long session steps up too.
    expect(rulerStep(600, 900)).toBeGreaterThanOrEqual(60);
  });

  it("only ever returns round values", () => {
    const allowed = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720];
    for (const units of [3, 17, 48, 121, 400, 1200]) {
      for (const w of [200, 480, 900, 1600]) {
        expect(allowed).toContain(rulerStep(units, w));
      }
    }
  });

  it("guarantees labels clear the minimum spacing", () => {
    for (const units of [10, 48, 300]) {
      for (const w of [300, 900, 1600]) {
        const step = rulerStep(units, w, 88);
        const pxPerLabel = (step / units) * w;
        // The largest step is a ceiling, so only clamp-limited cases may
        // fall short — everything else must satisfy the spacing rule.
        if (step !== 720) expect(pxPerLabel).toBeGreaterThanOrEqual(88);
      }
    }
  });

  it("degrades safely on empty input", () => {
    expect(rulerStep(0, 900)).toBe(1);
    expect(rulerStep(48, 0)).toBe(1);
  });
});

describe("rulerTicks", () => {
  it("emits a major tick on each step and a minor between", () => {
    const ticks = rulerTicks(20, 5);
    expect(ticks.filter((t) => t.major).map((t) => t.unit)).toEqual([0, 5, 10, 15, 20]);
    expect(ticks.filter((t) => !t.major).map((t) => t.unit)).toEqual([2.5, 7.5, 12.5, 17.5]);
  });

  it("marks majors correctly despite half-step float drift", () => {
    // 0.5 increments accumulate error; majors must not be missed.
    const ticks = rulerTicks(60, 1);
    expect(ticks.filter((t) => t.major)).toHaveLength(61);
  });

  it("degrades safely on empty input", () => {
    expect(rulerTicks(0, 5)).toEqual([]);
    expect(rulerTicks(20, 0)).toEqual([]);
  });
});

describe("formatUnitsDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatUnitsDuration(0)).toBe("0m");
    expect(formatUnitsDuration(45)).toBe("45m");
    expect(formatUnitsDuration(60)).toBe("1h");
    expect(formatUnitsDuration(83)).toBe("1h 23m");
  });
});
