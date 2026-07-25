/**
 * Integration tests for the segment pipeline — the contract that makes the
 * compiler's stream-copy assembly safe:
 *
 *   every capture unit (legacy JPEG still, VP8 webm clip, H.264 mp4 clip,
 *   any resolution) → exactly ONE second of 30fps video with pinned,
 *   bit-compatible encoder parameters, concatenable with `-c copy`.
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
import { buildSegment, probeFrameCount, SEGMENT_FPS } from "../src/segments.js";

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

async function probeDurationSeconds(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ],
    { timeout: 30_000 },
  );
  return parseFloat(stdout.trim());
}

describe.skipIf(!ffmpegAvailable)("segment pipeline", () => {
  let tmpDir: string;
  let jpegPath: string;
  let webmPath: string;
  let mp4Path: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-segments-"));

    // Legacy unit: a single JPEG still (odd size on purpose — the scale
    // filter must normalize it).
    jpegPath = path.join(tmpDir, "unit_jpeg.jpg");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", "testsrc2=size=1280x801:rate=1:duration=1",
        "-frames:v", "1",
        "-y", jpegPath,
      ],
      { timeout: 60_000 },
    );

    // Clip unit: VP8/WebM, 20 frames over 60s (the Chromium/Firefox shape).
    webmPath = path.join(tmpDir, "unit_clip.webm");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", "testsrc2=size=1668x1080:rate=1/3:duration=60",
        "-c:v", "libvpx",
        "-b:v", "133k",
        "-y", webmPath,
      ],
      { timeout: 120_000 },
    );

    // Clip unit: H.264/MP4 at a DIFFERENT resolution — Safari's format,
    // and simulates a mid-session display change. 12 frames over 60s.
    mp4Path = path.join(tmpDir, "unit_clip.mp4");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "lavfi",
        "-i", "testsrc2=size=1920x1080:rate=1/5:duration=60",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-y", mp4Path,
      ],
      { timeout: 120_000 },
    );
  }, 300_000);

  it("normalizes a JPEG still to exactly one second of 30fps video", async () => {
    const seg = await buildSegment(tmpDir, 0, jpegPath, "jpeg");
    expect(await probeFrameCount(seg)).toBe(SEGMENT_FPS);
  }, 120_000);

  it("normalizes a VP8 webm clip to exactly one second of 30fps video", async () => {
    const seg = await buildSegment(tmpDir, 1, webmPath, "webm");
    expect(await probeFrameCount(seg)).toBe(SEGMENT_FPS);
  }, 120_000);

  it("normalizes an H.264 mp4 clip to exactly one second of 30fps video", async () => {
    const seg = await buildSegment(tmpDir, 2, mp4Path, "mp4");
    expect(await probeFrameCount(seg)).toBe(SEGMENT_FPS);
  }, 120_000);

  it("stream-copy concatenates a mixed session into a coherent MP4", async () => {
    // Same order a real mixed session could produce: clip, jpeg fallback,
    // clip in another format/resolution.
    const segments = [
      await buildSegment(tmpDir, 10, webmPath, "webm"),
      await buildSegment(tmpDir, 11, jpegPath, "jpeg"),
      await buildSegment(tmpDir, 12, mp4Path, "mp4"),
    ];
    const listPath = path.join(tmpDir, "segments.txt");
    await fs.writeFile(
      listPath,
      segments.map((p) => `file '${p}'`).join("\n") + "\n",
    );
    const outPath = path.join(tmpDir, "timelapse.mp4");
    await execFileAsync(
      "ffmpeg",
      [
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", outPath,
      ],
      { timeout: 120_000 },
    );

    // 3 units → exactly 3 seconds, 90 frames, one decodable H.264 stream.
    expect(await probeFrameCount(outPath)).toBe(3 * SEGMENT_FPS);
    expect(await probeDurationSeconds(outPath)).toBeCloseTo(3, 1);

    // The copied stream must actually DECODE end to end (a bad splice can
    // still carry a plausible frame count).
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-v", "error", "-i", outPath, "-f", "null", "-"],
      { timeout: 120_000 },
    );
    expect(stderr.trim()).toBe("");
  }, 300_000);

  it("rejects an undecodable clip instead of emitting a bad segment", async () => {
    const garbagePath = path.join(tmpDir, "garbage.webm");
    await fs.writeFile(garbagePath, Buffer.from("not a webm file at all"));
    await expect(buildSegment(tmpDir, 99, garbagePath, "webm")).rejects.toThrow();
  }, 120_000);
});

describe.skipIf(ffmpegAvailable)("segment pipeline (skipped)", () => {
  it("skipped because ffmpeg/ffprobe are not installed", () => {
    console.warn("ffmpeg not found — segment pipeline tests were skipped");
  });
});
