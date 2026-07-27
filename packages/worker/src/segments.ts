// Segment building: normalizing capture units (legacy JPEGs and per-minute
// clips) into uniform 1-second video segments that the compiler can
// stream-copy concatenate into the final timelapse. Also the cut step of
// the edit feature, which exploits the same pinned grid. Kept free of DB/R2
// imports so the ffmpeg contracts are testable in isolation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KeptRange } from "@lookout/shared";

const execFileAsync = promisify(execFile);

/**
 * Drop the session's seed capture from the units that become video.
 * `rows` must be ordered by minute bucket ascending (the `DISTINCT ON`
 * contract in the compiler), so the seed is simply the first entry.
 *
 * The seed is the capture that STARTS the recording rather than closing a
 * recorded minute, and it is special in two measurable ways:
 *
 *  - It credits 0 tracked seconds. Both tracking modes agree: bucket mode
 *    reports `(distinct buckets - 1) * 60`, and in credit mode the seed
 *    capture is explicitly worth 0. Every other unit is worth 60s. Giving
 *    the seed a video second is therefore the exact reason a session
 *    reported N seconds of video against N-1 minutes of tracked time.
 *  - In clips mode it covers a fraction of a minute. The recorder cuts the
 *    opening clip after 2 frame intervals (~8s) so the session activates
 *    quickly, so that clip holds ~8s of wall clock where every later clip
 *    holds 60s. Rendered as an equal one-second segment it plays at ~8x
 *    while the rest of the timelapse plays at 60x — a visible slow-motion
 *    lurch at the head of every video.
 *
 * Excluding it makes the rule uniform: a capture earns video time exactly
 * when it earns tracked time. The timelapse still opens on motion (the
 * first shown unit is a full ~15-frame clip), which is what the dense
 * opening cadence was originally for.
 *
 * A single-unit session keeps its one unit — a zero-length video is worse
 * than an imprecise one.
 */
export function dropSeedUnit<T>(rows: T[]): T[] {
  return rows.length > 1 ? rows.slice(1) : rows;
}

/** Shared video filter: scale to 1920x1080 with pillarboxing. */
export const SCALE_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";

/** Output framerate of the compiled timelapse. Every capture unit (one
 *  recorded minute) becomes exactly one second of output at this rate. */
export const SEGMENT_FPS = 30;

/** How many segment builds run concurrently. Each build is a small
 *  single-threaded ffmpeg (see -threads 1 below), so the parallelism
 *  lives here rather than inside x264. */
export const SEGMENT_CONCURRENCY = 8;

/** Timeout for one segment build (demux + 30-frame encode). */
export const SEGMENT_TIMEOUT_MS = 120_000;

/** Timeout for final assembly. The happy path is a stream-copy remux
 *  (seconds even for 12h sessions); the budget covers the re-encode
 *  fallback too. */
export const ASSEMBLE_TIMEOUT_MS = 1_800_000;

/** GOP pinning shared by every encode that produces (part of) a compiled
 *  timelapse: a closed GOP of exactly one segment (1 second) starting on an
 *  IDR frame, scene-cut keyframes disabled. This grid is ALSO what makes
 *  compiled videos losslessly cuttable at second boundaries by the edit
 *  feature's stream-copy cut — every encode path (segments, assembly
 *  fallback, edited-video re-encode fallback) must keep it. */
export const SEGMENT_GOP_ARGS = [
  "-g", String(SEGMENT_FPS),
  "-keyint_min", String(SEGMENT_FPS),
  "-sc_threshold", "0",
  "-x264-params", "open-gop=0",
];

/** Pinned x264 parameters shared by EVERY segment encode. Segments must
 *  be bit-compatible so final assembly can stream-copy concatenate them:
 *  fixed profile/level, the pinned GOP grid above, single-threaded (the
 *  parallelism is at the segment level). Changing any of these breaks
 *  copy-concat — keep in lockstep with the assembly fallback and the
 *  mixed-session compile test. */
export const SEGMENT_ENCODE_ARGS = [
  "-c:v", "libx264",
  "-profile:v", "high",
  "-level:v", "4.0",
  "-preset", "fast",
  // CRF 18 = visually lossless: the compile step must not be a quality
  // event — the clip bitrate is the only intended quality dial. (The
  // legacy pipeline used CRF 28, which added a visible second generation
  // of loss on top of already-compressed clips.) Costs ~2.5-3x the
  // output size of CRF 28; timelapses are short, so absolute sizes stay
  // modest.
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  ...SEGMENT_GOP_ARGS,
  "-threads", "1",
];

/** Count the video frames in a file with ffprobe. */
export async function probeFrameCount(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-count_packets",
      "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_packets",
      "-of", "csv=p=0",
      filePath,
    ],
    { timeout: 30_000 },
  );
  return parseInt(stdout.trim(), 10);
}

/** Assert a built segment holds exactly SEGMENT_FPS frames. Strict — a
 *  short segment would silently desync every later minute of the video. */
async function verifySegmentFrameCount(filePath: string): Promise<void> {
  const frames = await probeFrameCount(filePath);
  if (frames !== SEGMENT_FPS) {
    throw new Error(`segment has ${frames} frames, expected ${SEGMENT_FPS}`);
  }
}

/**
 * Normalize one capture unit into a 1-second, 30fps MPEG-TS segment with
 * the pinned encoder parameters.
 *
 * - jpeg unit: the still is held for the full second — identical to the
 *   legacy one-frame-per-minute output.
 * - webm/mp4 clip: transcoded in ONE ffmpeg pass — decode, retime the
 *   REAL frame count evenly across the second (clips are VFR; the
 *   client's claimed frameCount is never trusted, ffprobe counts), scale,
 *   encode. No intermediate JPEG round-trip: that cost an extra encode+
 *   decode generation (visible softness on top of the clip's own
 *   compression) and an extra process per unit.
 *
 * Returns the segment path; throws if the unit is undecodable.
 */
export async function buildSegment(
  tmpDir: string,
  index: number,
  unitPath: string,
  format: string,
): Promise<string> {
  const segmentPath = path.join(
    tmpDir,
    `segment_${String(index).padStart(5, "0")}.ts`,
  );

  if (format === "jpeg") {
    // -framerate 1 over one still = exactly one second of input; fps
    // duplicates it onto the 30fps grid, -frames:v hard-caps the length.
    await execFileAsync(
      "ffmpeg",
      [
        "-framerate", "1",
        "-i", unitPath,
        "-vf", `${SCALE_FILTER},fps=${SEGMENT_FPS}`,
        "-frames:v", String(SEGMENT_FPS),
        ...SEGMENT_ENCODE_ARGS,
        "-f", "mpegts",
        "-y",
        segmentPath,
      ],
      { timeout: SEGMENT_TIMEOUT_MS },
    );
  } else {
    const frames = await probeFrameCount(unitPath);
    if (!Number.isFinite(frames) || frames < 1) {
      throw new Error("clip contained no decodable frames");
    }
    // setpts spreads the N decoded frames evenly across [0, 1s); fps
    // resamples onto the 30fps grid; tpad clone-extends the last frame so
    // PTS rounding can never come up a frame short; -frames:v caps at
    // exactly one segment.
    await execFileAsync(
      "ffmpeg",
      [
        "-i", unitPath,
        "-vf",
        `setpts=N/(${frames}*TB),${SCALE_FILTER},fps=${SEGMENT_FPS},tpad=stop_mode=clone:stop=-1`,
        "-frames:v", String(SEGMENT_FPS),
        ...SEGMENT_ENCODE_ARGS,
        "-f", "mpegts",
        "-y",
        segmentPath,
      ],
      { timeout: SEGMENT_TIMEOUT_MS },
    );
  }

  await verifySegmentFrameCount(segmentPath);
  return segmentPath;
}

/**
 * The edit feature's cut step: produce a video containing only the kept
 * ranges of a compiled original.
 *
 * Fast path (`aligned`): every second of the original starts on an IDR
 * frame in a closed GOP (the pinned grid above), and one second = one
 * capture unit. Each kept range is extracted losslessly with an input seek
 * to its IDR (`-ss` lands exactly on the second boundary) plus an exact
 * packet count (`-frames:v` applies to copied packets), into an MPEG-TS
 * intermediate; the intermediates stream-copy concat into the edited MP4.
 * NOT the concat demuxer's inpoint/outpoint — outpoint is dts-based, and
 * B-frame dts offsets leak ~2 frames of the CUT region past each boundary.
 * This path is I/O-bound (seconds even for a 12-hour session) and adds
 * zero generation loss.
 *
 * Fallback (originals that predate GOP pinning, or a failed copy): one
 * frame-exact re-encode of the whole original through a `select` filter
 * keeping pts ∈ [start, end) per range, with the pinned parameters — so
 * the output is itself aligned for future edits.
 */
export async function cutVideoToKeptRanges(
  tmpDir: string,
  originalPath: string,
  keptRanges: KeptRange[],
  aligned: boolean,
): Promise<string> {
  if (keptRanges.length === 0) {
    throw new Error("cutVideoToKeptRanges: no kept ranges");
  }

  const editedPath = path.join(tmpDir, "edited.mp4");
  const keptUnits = keptRanges.reduce((n, r) => n + (r.end - r.start), 0);
  const expectedFrames = keptUnits * SEGMENT_FPS;

  const verify = async (label: string, toleranceFrames: number) => {
    const stat = await fs.stat(editedPath);
    if (stat.size === 0) throw new Error(`${label}: ffmpeg produced empty output`);
    const frames = await probeFrameCount(editedPath);
    if (
      !Number.isFinite(frames) ||
      Math.abs(frames - expectedFrames) > toleranceFrames
    ) {
      throw new Error(
        `${label}: frame count mismatch: expected ${expectedFrames} (±${toleranceFrames}), got ${frames}`,
      );
    }
  };

  if (aligned) {
    try {
      // 1. Extract each kept range losslessly into a TS intermediate.
      const rangePaths: string[] = [];
      for (const [i, r] of keptRanges.entries()) {
        const rangePath = path.join(tmpDir, `kept_${i}.ts`);
        await execFileAsync(
          "ffmpeg",
          [
            "-ss", String(r.start),
            "-i", originalPath,
            "-c", "copy",
            "-frames:v", String((r.end - r.start) * SEGMENT_FPS),
            "-avoid_negative_ts", "make_zero",
            "-f", "mpegts",
            "-y",
            rangePath,
          ],
          { timeout: ASSEMBLE_TIMEOUT_MS },
        );
        rangePaths.push(rangePath);
      }

      // 2. Stream-copy concat the ranges (same mechanism as assembly).
      const listPath = path.join(tmpDir, "kept_ranges.txt");
      await fs.writeFile(
        listPath,
        rangePaths.map((p) => `file '${p}'`).join("\n") + "\n",
      );
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "concat",
          "-safe", "0",
          "-i", listPath,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y",
          editedPath,
        ],
        { timeout: ASSEMBLE_TIMEOUT_MS },
      );
      // The copy path must be frame-EXACT — that's the whole point.
      await verify("Edited MP4 (copy)", 0);
      return editedPath;
    } catch (err) {
      // The only way a cut costs quality. The copy path is bit-exact
      // (proven in cutVideo.test.ts by comparing decoded frame hashes),
      // so falling through here means the user's timelapse takes a
      // generation of loss it shouldn't have. Loud, not a debug aside.
      console.error(
        "Stream-copy cut FAILED — falling back to a re-encode, so this " +
          "timelapse loses a generation of quality. Investigate: the " +
          "original was expected to be on the pinned 1s IDR grid.",
        err,
      );
    }
  }

  // Frame-exact single-pass re-encode: keep frames whose pts falls in any
  // kept [start, end) range, then retime onto a contiguous 30fps grid.
  const keepExpr = keptRanges
    .map((r) => `(gte(t\\,${r.start})*lt(t\\,${r.end}))`)
    .join("+");
  await execFileAsync(
    "ffmpeg",
    [
      "-i", originalPath,
      "-vf", `select='${keepExpr}',setpts=N/(${SEGMENT_FPS}*TB)`,
      "-r", String(SEGMENT_FPS),
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      ...SEGMENT_GOP_ARGS,
      "-movflags", "+faststart",
      "-y",
      editedPath,
    ],
    { timeout: ASSEMBLE_TIMEOUT_MS },
  );
  await verify("Edited MP4 (re-encoded)", 1);
  return editedPath;
}
