/**
 * Integration tests for the edit feature's cut step: a compiled original
 * (built exactly like the production pipeline — pinned 1s closed-GOP
 * segments, stream-copy concat) cut down to kept ranges.
 *
 * Verifies the core promise of the edit design: cuts on second boundaries
 * are LOSSLESS stream copies with exact frame counts, and the re-encode
 * fallback produces the same shape for non-aligned originals.
 *
 * Uses real ffmpeg with synthetic inputs (no DB, no R2). Skipped when
 * ffmpeg isn't installed — CI installs it explicitly.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeKeptRanges, type CutInterval } from "@lookout/shared";
import {
  buildSegment,
  cutVideoToKeptRanges,
  probeFrameCount,
  SEGMENT_FPS,
} from "../src/segments.js";

const execFileAsync = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 10_000 });
    await execFileAsync("ffprobe", ["-version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const ffmpegAvailable = await hasFfmpeg();

/** Per-frame checksums of the DECODED video, ignoring container timing.
 *  Identical sequences mean identical pixels, frame for frame. */
async function frameHashes(filePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-an", "-f", "framemd5", "-"],
    { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    // Columns: stream, dts, pts, duration, size, hash. Only the hash is
    // comparable — a cut restarts timestamps at zero by design.
    .map((l) => l.trim().split(/[,\s]+/).pop() as string)
    .filter(Boolean);
}

const UNITS = 6;

describe.skipIf(!ffmpegAvailable)("cutVideoToKeptRanges", () => {
  let tmpDir: string;
  let originalPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-"));

    // Build a production-shaped original: UNITS distinct JPEG stills →
    // 1s pinned segments → stream-copy concat.
    const segments: string[] = [];
    for (let i = 0; i < UNITS; i++) {
      const jpeg = path.join(tmpDir, `unit_${i}.jpg`);
      await execFileAsync(
        "ffmpeg",
        [
          "-f", "lavfi",
          "-i", `testsrc2=size=640x360:rate=1:duration=1`,
          "-frames:v", "1",
          "-y", jpeg,
        ],
        { timeout: 60_000 },
      );
      segments.push(await buildSegment(tmpDir, i, jpeg, "jpeg"));
    }
    const listPath = path.join(tmpDir, "segments.txt");
    await fs.writeFile(
      listPath,
      segments.map((p) => `file '${p}'`).join("\n") + "\n",
    );
    originalPath = path.join(tmpDir, "original.mp4");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", originalPath,
      ],
      { timeout: 120_000 },
    );
    expect(await probeFrameCount(originalPath)).toBe(UNITS * SEGMENT_FPS);
  }, 300_000);

  it("losslessly cuts a middle range with stream copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-a-"));
    // Keep units 0-1 and 4-5 (cut 2 and 3).
    const edited = await cutVideoToKeptRanges(
      dir,
      originalPath,
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      true,
    );
    expect(await probeFrameCount(edited)).toBe(4 * SEGMENT_FPS);
  }, 120_000);

  it("cuts head and tail ranges", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-b-"));
    const edited = await cutVideoToKeptRanges(
      dir,
      originalPath,
      [{ start: 1, end: 5 }],
      true,
    );
    expect(await probeFrameCount(edited)).toBe(4 * SEGMENT_FPS);
  }, 120_000);

  it("re-encode fallback produces the same frame counts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-c-"));
    const edited = await cutVideoToKeptRanges(
      dir,
      originalPath,
      [
        { start: 0, end: 1 },
        { start: 3, end: 6 },
      ],
      false, // force the re-encode path
    );
    const frames = await probeFrameCount(edited);
    // Re-encode is CFR at 30fps over the same ranges — allow ±1 frame of
    // container rounding.
    expect(Math.abs(frames - 4 * SEGMENT_FPS)).toBeLessThanOrEqual(1);
  }, 180_000);

  it("computeKeptRanges output plugs directly into the cutter", async () => {
    // Units captured one per minute starting at T0; cut minutes 2..4.
    const T0 = Date.parse("2026-07-01T10:00:00.000Z");
    const unitTimes = Array.from({ length: UNITS }, (_, i) => T0 + i * 60_000);
    const cuts: CutInterval[] = [
      {
        start: new Date(T0 + 2 * 60_000).toISOString(),
        end: new Date(T0 + 4 * 60_000).toISOString(),
      },
    ];
    const kept = computeKeptRanges(unitTimes, cuts);
    expect(kept).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-d-"));
    const edited = await cutVideoToKeptRanges(dir, originalPath, kept, true);
    expect(await probeFrameCount(edited)).toBe(4 * SEGMENT_FPS);
  }, 120_000);

  /**
   * The quality guarantee, proven rather than asserted.
   *
   * `-f framemd5` hashes every DECODED frame, so if the cut is a true
   * stream copy the kept frames decode to byte-identical pixels. Any
   * re-encode — even a visually lossless one — changes them.
   */
  it("is bit-exact: kept frames decode identically to the original", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-lossless-"));
    const kept = [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ];
    const edited = await cutVideoToKeptRanges(dir, originalPath, kept, true);

    const originalHashes = await frameHashes(originalPath);
    const editedHashes = await frameHashes(edited);

    // The frames those ranges cover, taken straight from the source.
    const expected = kept.flatMap((r) =>
      originalHashes.slice(r.start * SEGMENT_FPS, r.end * SEGMENT_FPS),
    );

    expect(editedHashes).toHaveLength(expected.length);
    expect(editedHashes).toEqual(expected);
  }, 180_000);

  it("shows the fallback re-encode is NOT bit-exact, so the copy path matters", async () => {
    // Guards the claim above from rotting: if someone makes the copy path
    // silently re-encode, the test above would still pass against a
    // similarly re-encoded expectation unless we know the two differ.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-lossy-"));
    const kept = [{ start: 0, end: 2 }];
    const reencoded = await cutVideoToKeptRanges(dir, originalPath, kept, false);

    const originalHashes = await frameHashes(originalPath);
    const lossyHashes = await frameHashes(reencoded);
    expect(lossyHashes).not.toEqual(originalHashes.slice(0, 2 * SEGMENT_FPS));
  }, 180_000);

  it("refuses an empty kept list", async () => {
    await expect(
      cutVideoToKeptRanges(tmpDir, originalPath, [], true),
    ).rejects.toThrow(/no kept ranges/);
  });
});

/**
 * Backward compatibility: originals compiled before the 6fps change are
 * 30fps, and they live in R2 forever — a re-edit of one runs through the
 * SAME cut code as new videos. The cutter must take its frames-per-unit
 * from the FILE, not from SEGMENT_FPS: trusting the constant would copy a
 * fifth of every kept range, and the frame-count verify (derived from the
 * same constant) would pass the truncated result.
 */
describe.skipIf(!ffmpegAvailable)("cutVideoToKeptRanges — legacy 30fps originals", () => {
  const LEGACY_FPS = 30;
  let tmpDir: string;
  let legacyPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-legacy-"));
    // Build a legacy-shaped original directly: 6 one-second units on the
    // pinned 1s closed-GOP grid at 30fps, exactly what the old pipeline
    // published.
    legacyPath = path.join(tmpDir, "legacy.mp4");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", `testsrc2=size=640x360:rate=${LEGACY_FPS}:duration=${UNITS}`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-g", String(LEGACY_FPS),
        "-keyint_min", String(LEGACY_FPS),
        "-sc_threshold", "0",
        "-x264-params", "open-gop=0",
        "-movflags", "+faststart",
        "-y", legacyPath,
      ],
      { timeout: 120_000 },
    );
    expect(await probeFrameCount(legacyPath)).toBe(UNITS * LEGACY_FPS);
  }, 300_000);

  it("stream-copies kept ranges using the original's own fps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-legacy-a-"));
    const edited = await cutVideoToKeptRanges(
      dir,
      legacyPath,
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      true,
    );
    // 4 kept units × the LEGACY rate — not SEGMENT_FPS.
    expect(await probeFrameCount(edited)).toBe(4 * LEGACY_FPS);
  }, 180_000);

  it("is bit-exact on a legacy original", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-legacy-b-"));
    const kept = [{ start: 1, end: 3 }];
    const edited = await cutVideoToKeptRanges(dir, legacyPath, kept, true);

    const originalHashes = await frameHashes(legacyPath);
    const editedHashes = await frameHashes(edited);
    expect(editedHashes).toEqual(
      originalHashes.slice(1 * LEGACY_FPS, 3 * LEGACY_FPS),
    );
  }, 180_000);

  it("re-encode fallback keeps the legacy original's rate", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-cut-legacy-c-"));
    const edited = await cutVideoToKeptRanges(
      dir,
      legacyPath,
      [{ start: 2, end: 5 }],
      false, // force the re-encode path
    );
    const frames = await probeFrameCount(edited);
    expect(Math.abs(frames - 3 * LEGACY_FPS)).toBeLessThanOrEqual(1);
  }, 180_000);
});
