// Cut lists: the canonical representation of session edits.
//
// An edit is a list of ABSOLUTE wall-clock intervals of the session that
// should not exist in any output — never "video offset + duration". Lookout
// is heartbeat-based: the session's identity is its per-minute capture
// timestamps, and the compiled video, /timings (→ Hackatime heartbeats), and
// trackedSeconds are all derived views of them. Expressing the edit in the
// same domain lets one list drive all three consistently.
//
// THE membership rule (shared by server, worker, and clients — never
// reimplement it): a capture unit is cut iff its capture timestamp
// (coalesce(captured_at, requested_at)) falls in [start, end) of any
// interval. Granularity is therefore whole capture units (minutes), which is
// also heartbeat granularity.

/** One cut interval. ISO-8601 UTC wall-clock times; `end` exclusive. */
export interface CutInterval {
  start: string;
  end: string;
}

/** Max intervals per session. Bounds hostile payloads; a 12h session has at
 *  most 720 units, and real edits are a handful of regions. */
export const MAX_CUT_INTERVALS = 120;

/** Max user-initiated cut-compiles per session. Each is cheap (stream copy)
 *  but enqueues worker jobs — bound the loop. */
export const MAX_USER_RECOMPILES = 5;

/** How long after the last cut-compile the uncut original video is retained
 *  for further re-edits. After this the retention job deletes the original
 *  of EDITED sessions (the cut content must eventually be truly gone) and
 *  editing freezes. Uncut sessions keep their single video forever. */
export const EDIT_WINDOW_DAYS = 7;

/** How far outside [startedAt, stoppedAt] a cut interval may reach before
 *  being clamped. Mirrors the capture-time trust envelope. */
export const CUT_BOUNDS_SLACK_MS = 5 * 60_000;

export type NormalizeCutsResult =
  | { ok: true; cuts: CutInterval[] }
  | { ok: false; error: string };

/**
 * Validate and canonicalize a raw cut list: parseable ISO dates, end > start,
 * clamped to the session bounds, sorted by start, overlapping/adjacent
 * intervals merged. The canonical form is what gets persisted, so equality
 * checks and previews are stable regardless of how the client drew regions.
 */
export function normalizeCuts(
  raw: unknown,
  bounds?: { minMs: number; maxMs: number },
): NormalizeCutsResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "cuts must be an array" };
  }
  if (raw.length > MAX_CUT_INTERVALS) {
    return { ok: false, error: `cuts cannot exceed ${MAX_CUT_INTERVALS} intervals` };
  }

  const minMs = bounds ? bounds.minMs - CUT_BOUNDS_SLACK_MS : -Infinity;
  const maxMs = bounds ? bounds.maxMs + CUT_BOUNDS_SLACK_MS : Infinity;

  const parsed: Array<{ startMs: number; endMs: number }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "each cut must be an object with start and end" };
    }
    const { start, end } = entry as Record<string, unknown>;
    if (typeof start !== "string" || typeof end !== "string") {
      return { ok: false, error: "cut start and end must be ISO-8601 strings" };
    }
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      return { ok: false, error: "cut start and end must be valid ISO-8601 dates" };
    }
    if (endMs <= startMs) {
      return { ok: false, error: "cut end must be after start" };
    }
    // Clamp to the session envelope; drop intervals entirely outside it.
    const clampedStart = Math.max(startMs, minMs);
    const clampedEnd = Math.min(endMs, maxMs);
    if (clampedEnd <= clampedStart) continue;
    parsed.push({ startMs: clampedStart, endMs: clampedEnd });
  }

  parsed.sort((a, b) => (a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs));

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const cur of parsed) {
    const last = merged[merged.length - 1];
    if (last && cur.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cur.endMs);
    } else {
      merged.push({ ...cur });
    }
  }

  return {
    ok: true,
    cuts: merged.map((m) => ({
      start: new Date(m.startMs).toISOString(),
      end: new Date(m.endMs).toISOString(),
    })),
  };
}

/** Membership: is a capture taken at `timeMs` removed by `cuts`?
 *  Interval semantics are [start, end) — end-exclusive. */
export function isCutAt(timeMs: number, cuts: CutInterval[]): boolean {
  for (const c of cuts) {
    const s = Date.parse(c.start);
    const e = Date.parse(c.end);
    if (timeMs >= s && timeMs < e) return true;
  }
  return false;
}

/** A contiguous run of KEPT units, as half-open video-second indices.
 *  Because one unit = exactly one second of compiled output, these double
 *  as ffmpeg inpoint/outpoint pairs on the original video. */
export interface KeptRange {
  /** First kept unit index (inclusive) = video inpoint in seconds. */
  start: number;
  /** One past the last kept unit index = video outpoint in seconds. */
  end: number;
}

/**
 * Map unit capture times (epoch ms, in video order) through the cut list to
 * the contiguous kept ranges of the compiled video. Returns [] when
 * everything is cut.
 */
export function computeKeptRanges(
  unitTimesMs: number[],
  cuts: CutInterval[],
): KeptRange[] {
  const ranges: KeptRange[] = [];
  let open: KeptRange | null = null;
  for (let i = 0; i < unitTimesMs.length; i++) {
    if (isCutAt(unitTimesMs[i], cuts)) {
      if (open) {
        ranges.push(open);
        open = null;
      }
    } else {
      if (open) open.end = i + 1;
      else open = { start: i, end: i + 1 };
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

/** Count units removed by the cut list. */
export function countCutUnits(unitTimesMs: number[], cuts: CutInterval[]): number {
  let n = 0;
  for (const t of unitTimesMs) if (isCutAt(t, cuts)) n++;
  return n;
}

/** One entry of `sessions.video_units`: a capture unit that made it into the
 *  compiled original video, in output order. Index in the array = the second
 *  of the video the unit occupies = its minute of real time. */
export interface VideoUnit {
  /** Capture moment (coalesce(captured_at, requested_at)), ISO-8601. */
  capturedAt: string;
  /** Screenshot row id, for debugging/traceability. */
  screenshotId: string;
}

/** The slice of a confirmed screenshot row that cut/tracked-time math needs. */
export interface CaptureRowForCuts {
  /** coalesce(captured_at, requested_at), epoch ms. */
  timeMs: number;
  /** Credit-mode per-capture credit (0 or 60); null on bucket-mode rows. */
  creditedSeconds: number | null;
  minuteBucket: number;
}

/**
 * Credited seconds removed by `cuts`, per tracking mode — the delta between
 * raw tracked time and what the kept captures are worth. Used identically by
 * the server's PUT /cuts preview and the worker's authoritative cut-compile
 * write, so the preview a user sees is exactly what lands.
 *
 * - credit mode: sum of credited_seconds over CUT rows.
 * - bucket mode: raw − max(0, (distinct kept minute buckets − 1) × 60),
 *   mirroring the legacy bucket formula so an empty cut list yields 0.
 */
export function computeCutSeconds(
  rows: CaptureRowForCuts[],
  trackingMode: "credit" | "bucket",
  rawTrackedSeconds: number,
  cuts: CutInterval[],
): number {
  if (cuts.length === 0) return 0;
  if (trackingMode === "credit") {
    let cut = 0;
    for (const r of rows) {
      if (isCutAt(r.timeMs, cuts)) cut += r.creditedSeconds ?? 0;
    }
    return Math.min(cut, rawTrackedSeconds);
  }
  const keptBuckets = new Set<number>();
  for (const r of rows) {
    if (!isCutAt(r.timeMs, cuts)) keptBuckets.add(r.minuteBucket);
  }
  const keptTracked = Math.max(0, (keptBuckets.size - 1) * 60);
  return Math.max(0, rawTrackedSeconds - keptTracked);
}
