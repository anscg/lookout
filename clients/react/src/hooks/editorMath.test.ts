import { describe, expect, it } from "vitest";
import type { CutInterval, VideoUnit } from "@lookout/shared";
import {
  regionsToCuts,
  cutsToRegions,
  normalizeRegions,
  cutUnitCount,
  unitIsCut,
  regionAtTime,
  gapIndices,
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

  it("serializes a region as [firstUnit, lastUnit + 60s)", () => {
    const units = makeUnits(5);
    const cuts = regionsToCuts([{ startUnit: 1, endUnit: 3 }], units);
    expect(cuts).toEqual<CutInterval[]>([
      {
        start: units[1].capturedAt,
        end: new Date(Date.parse(units[2].capturedAt) + 60_000).toISOString(),
      },
    ]);
  });

  it("drops empty regions", () => {
    const units = makeUnits(5);
    expect(regionsToCuts([{ startUnit: 2, endUnit: 2 }], units)).toEqual([]);
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

describe("formatUnitsDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatUnitsDuration(0)).toBe("0m");
    expect(formatUnitsDuration(45)).toBe("45m");
    expect(formatUnitsDuration(60)).toBe("1h");
    expect(formatUnitsDuration(83)).toBe("1h 23m");
  });
});
