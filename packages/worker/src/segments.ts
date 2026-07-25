// Segment building: normalizing capture units (legacy JPEGs and per-minute
// clips) into uniform 1-second video segments that the compiler can
// stream-copy concatenate into the final timelapse. Kept free of DB/R2
// imports so the ffmpeg contract is testable in isolation.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

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

/** Pinned x264 parameters shared by EVERY segment encode. Segments must
 *  be bit-compatible so final assembly can stream-copy concatenate them:
 *  fixed profile/level, a closed GOP of exactly one segment starting on
 *  an IDR frame, scene-cut keyframes disabled, single-threaded (the
 *  parallelism is at the segment level). Changing any of these breaks
 *  copy-concat — keep in lockstep with the assembly fallback and the
 *  mixed-session compile test. */
export const SEGMENT_ENCODE_ARGS = [
  "-c:v", "libx264",
  "-profile:v", "high",
  "-level:v", "4.0",
  "-preset", "fast",
  "-crf", "28",
  "-pix_fmt", "yuv420p",
  "-g", String(SEGMENT_FPS),
  "-keyint_min", String(SEGMENT_FPS),
  "-sc_threshold", "0",
  "-x264-params", "open-gop=0",
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
 * - webm/mp4 clip: demuxed to frames first so the REAL frame count drives
 *   timing (clips are VFR — static screens legitimately emit few frames;
 *   the client's claimed frameCount is never trusted), then the N frames
 *   are spread evenly across the second.
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

  // Resolve the unit to an image-sequence input: pattern + frame count.
  let inputPattern = unitPath;
  let frameCount = 1;
  if (format !== "jpeg") {
    const framesDir = path.join(tmpDir, `unit_${index}`);
    await fs.mkdir(framesDir, { recursive: true });
    await execFileAsync(
      "ffmpeg",
      [
        "-i", unitPath,
        // Passthrough timing: dump each encoded frame once, no
        // duplication to a target rate.
        "-vsync", "0",
        "-q:v", "2",
        "-y",
        path.join(framesDir, "f_%04d.jpg"),
      ],
      { timeout: SEGMENT_TIMEOUT_MS },
    );
    const files = (await fs.readdir(framesDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (files.length === 0) {
      throw new Error("clip contained no decodable frames");
    }
    inputPattern = path.join(framesDir, "f_%04d.jpg");
    frameCount = files.length;
  }

  // -framerate N over N frames = exactly one second of input; the fps
  // filter resamples that second onto the 30fps output grid (duplicating
  // for sparse clips and stills, dropping if a clip somehow over-delivers),
  // and -frames:v hard-caps the segment length.
  await execFileAsync(
    "ffmpeg",
    [
      "-framerate", String(frameCount),
      "-i", inputPattern,
      "-vf", `${SCALE_FILTER},fps=${SEGMENT_FPS}`,
      "-frames:v", String(SEGMENT_FPS),
      ...SEGMENT_ENCODE_ARGS,
      "-f", "mpegts",
      "-y",
      segmentPath,
    ],
    { timeout: SEGMENT_TIMEOUT_MS },
  );

  await verifySegmentFrameCount(segmentPath);
  return segmentPath;
}
