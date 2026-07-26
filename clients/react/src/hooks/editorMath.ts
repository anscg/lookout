// Pure math for the timelapse editor: converting between the video's time
// axis (1 second = 1 capture unit = 1 real-world minute) and the wall-clock
// cut intervals the server stores. Kept DOM-free so it's unit-testable.

import { isCutAt, type CutInterval, type VideoUnit } from "@lookout/shared";
import { SCREENSHOT_INTERVAL_MS } from "@lookout/shared";

/** A cut region in unit space: [startUnit, endUnit) video-second indices.
 *  This is the editor's working representation — integers, so regions are
 *  inherently snapped to capture-unit boundaries. */
export interface UnitRegion {
  startUnit: number;
  endUnit: number;
}

/** Clamp + floor a video-time (seconds) to a valid unit index. */
export function unitAtTime(t: number, unitCount: number): number {
  return Math.max(0, Math.min(unitCount - 1, Math.floor(t)));
}

/**
 * Serialize unit regions to the wall-clock cut intervals the server stores.
 * A region [i, j) covers units i..j-1, i.e. wall-clock
 * [units[i].capturedAt, units[j-1].capturedAt + 60s). Round-trips losslessly
 * through the server's membership rule (ts ∈ [start, end)).
 */
export function regionsToCuts(
  regions: UnitRegion[],
  units: VideoUnit[],
): CutInterval[] {
  return regions
    .filter((r) => r.endUnit > r.startUnit)
    .map((r) => ({
      start: units[r.startUnit].capturedAt,
      end: new Date(
        Date.parse(units[r.endUnit - 1].capturedAt) + SCREENSHOT_INTERVAL_MS,
      ).toISOString(),
    }));
}

/**
 * Project stored wall-clock cuts back into unit regions via the shared
 * membership rule, merging adjacent cut units into contiguous regions.
 * The exact inverse of regionsToCuts for any normalized list.
 */
export function cutsToRegions(
  cuts: CutInterval[],
  units: VideoUnit[],
): UnitRegion[] {
  const regions: UnitRegion[] = [];
  let open: UnitRegion | null = null;
  for (let i = 0; i < units.length; i++) {
    const cut = isCutAt(Date.parse(units[i].capturedAt), cuts);
    if (cut) {
      if (open) open.endUnit = i + 1;
      else open = { startUnit: i, endUnit: i + 1 };
    } else if (open) {
      regions.push(open);
      open = null;
    }
  }
  if (open) regions.push(open);
  return regions;
}

/** Merge overlapping/adjacent regions and drop empties — keeps the editor
 *  state canonical after drags so regions never visually stack. */
export function normalizeRegions(regions: UnitRegion[]): UnitRegion[] {
  const sorted = regions
    .filter((r) => r.endUnit > r.startUnit)
    .slice()
    .sort((a, b) => a.startUnit - b.startUnit);
  const merged: UnitRegion[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startUnit <= last.endUnit) {
      last.endUnit = Math.max(last.endUnit, r.endUnit);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Total units removed by a region list (assumed normalized). */
export function cutUnitCount(regions: UnitRegion[]): number {
  return regions.reduce((n, r) => n + (r.endUnit - r.startUnit), 0);
}

/** Is unit `i` inside any region? */
export function unitIsCut(i: number, regions: UnitRegion[]): boolean {
  return regions.some((r) => i >= r.startUnit && i < r.endUnit);
}

/** The region containing video time `t`, if any. */
export function regionAtTime(
  t: number,
  regions: UnitRegion[],
): UnitRegion | null {
  return regions.find((r) => t >= r.startUnit && t < r.endUnit) ?? null;
}

/**
 * Recording pauses to mark on the timeline: indices `i` where the gap
 * between unit i-1 and unit i exceeds ~1.5 capture intervals (i.e. the
 * recording paused/stalled between those two video seconds).
 */
export function gapIndices(units: VideoUnit[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < units.length; i++) {
    const delta =
      Date.parse(units[i].capturedAt) - Date.parse(units[i - 1].capturedAt);
    if (delta > SCREENSHOT_INTERVAL_MS * 1.5) gaps.push(i);
  }
  return gaps;
}

/** "1h 23m" / "23m" / "45s" — compact duration for the editor footer. */
export function formatUnitsDuration(unitCount: number): string {
  const totalMinutes = unitCount; // one unit = one real-world minute
  if (totalMinutes < 1) return "0m";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Wall-clock label (HH:MM, local) for a unit. */
export function unitClockLabel(unit: VideoUnit): string {
  const d = new Date(unit.capturedAt);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
