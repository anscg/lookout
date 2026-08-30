/**
 * Both segment builders must write the same colour. Segments stream-copy
 * concatenate and the assembled file carries only the FIRST segment's tags,
 * so a jpeg unit coming out full-range against a clip's limited meant one of
 * the two rendered wrong.
 *
 * Real ffmpeg, synthetic inputs. Skipped when ffmpeg isn't installed.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSegment,
  SEGMENT_X264_PARAMS,
  type SegmentQuality,
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

type ColourTags = {
  pix_fmt: string;
  color_range: string;
  color_space: string;
  color_primaries: string;
  color_transfer: string;
};

async function probeColourTags(filePath: string): Promise<ColourTags> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries",
      "stream=pix_fmt,color_range,color_space,color_primaries,color_transfer",
      "-of", "default=nw=1",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const tags: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    // MPEG-TS lists the stream twice; first value per key wins.
    const [k, v] = line.trim().split("=");
    if (k && v && !(k in tags)) tags[k] = v;
  }
  return tags as ColourTags;
}

/** Decode one frame in the segment's OWN pixel format, so samples come back
 *  as stored rather than converted through whatever it's tagged — that's
 *  what copy-concat actually preserves. */
async function storedLuma(
  filePath: string,
  x: number,
  y: number,
  width = 1920,
): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-frames:v", "1", "-c:v", "rawvideo", "-f", "rawvideo", "-"],
    { timeout: 30_000, encoding: "buffer", maxBuffer: 1 << 28 },
  );
  return (stdout as unknown as Buffer)[y * width + x];
}

describe("x264 parameter string", () => {
  // -x264-params twice keeps only the last one, so splitting colour into a
  // second flag silently drops the closed-GOP grid.
  it("carries the GOP and colour keys together", () => {
    expect(SEGMENT_X264_PARAMS).toContain("open-gop=0");
    expect(SEGMENT_X264_PARAMS).toContain("colorprim=bt709");
    expect(SEGMENT_X264_PARAMS).toContain("transfer=bt709");
    expect(SEGMENT_X264_PARAMS).toContain("colormatrix=bt709");
  });
});

describe.skipIf(!ffmpegAvailable)("segment colour tagging", () => {
  let tmpDir: string;
  let jpegPath: string;
  let webmPath: string;
  let mp4Path: string;

  // Flat mid-grey, 4:3 so the output is pillarboxed and the pad fill gets
  // checked too.
  const GREY = "0x808080";

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookout-colour-"));

    jpegPath = path.join(tmpDir, "unit.jpg");
    await execFileAsync(
      "ffmpeg",
      ["-f", "lavfi", "-i", `color=c=${GREY}:size=1440x1080:rate=1:duration=1`,
       "-frames:v", "1", "-y", jpegPath],
      { timeout: 60_000 },
    );

    webmPath = path.join(tmpDir, "unit.webm");
    await execFileAsync(
      "ffmpeg",
      ["-f", "lavfi", "-i", `color=c=${GREY}:size=1440x1080:rate=1/10:duration=60`,
       "-c:v", "libvpx", "-b:v", "2000k", "-y", webmPath],
      { timeout: 120_000 },
    );

    mp4Path = path.join(tmpDir, "unit.mp4");
    await execFileAsync(
      "ffmpeg",
      ["-f", "lavfi", "-i", `color=c=${GREY}:size=1440x1080:rate=1/10:duration=60`,
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", "-y", mp4Path],
      { timeout: 120_000 },
    );
  }, 300_000);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const EXPECTED: ColourTags = {
    pix_fmt: "yuv420p",
    color_range: "tv",
    color_space: "bt709",
    color_primaries: "bt709",
    color_transfer: "bt709",
  };

  it("tags a jpeg unit and a clip unit the same", async () => {
    const still = await buildSegment(tmpDir, 0, jpegPath, "jpeg");
    const clip = await buildSegment(tmpDir, 1, webmPath, "webm");

    // The still used to come back yuvj420p / pc against the clip's tv.
    expect(await probeColourTags(still)).toEqual(EXPECTED);
    expect(await probeColourTags(clip)).toEqual(EXPECTED);
  }, 180_000);

  it("stores the same grey at the same level in both", async () => {
    const still = await buildSegment(tmpDir, 2, jpegPath, "jpeg");
    const clip = await buildSegment(tmpDir, 3, webmPath, "webm");

    // The still used to store 128 against the clip's 126 — the ~2 levels
    // that showed as a step on the flush frame.
    const stillY = await storedLuma(still, 960, 540);
    const clipY = await storedLuma(clip, 960, 540);
    expect(Math.abs(stillY - clipY)).toBeLessThanOrEqual(1);
    expect(stillY).toBeGreaterThanOrEqual(124);
    expect(stillY).toBeLessThanOrEqual(128);
  }, 180_000);

  it("pillarboxes in limited-range black, not raised black", async () => {
    // pad runs after the conversion, so the bars get the output's black.
    const still = await buildSegment(tmpDir, 4, jpegPath, "jpeg");
    expect(await storedLuma(still, 4, 540)).toBe(16);
  }, 180_000);

  it("tags an mp4 clip identically to a webm clip", async () => {
    // One session can switch payload format between minutes, and the
    // containers disagree about what they claim.
    const fromWebm = await buildSegment(tmpDir, 5, webmPath, "webm");
    const fromMp4 = await buildSegment(tmpDir, 6, mp4Path, "mp4");
    expect(await probeColourTags(fromMp4)).toEqual(
      await probeColourTags(fromWebm),
    );
  }, 180_000);

  it("tags the preview tier the same as the publish tier", async () => {
    // Both tiers concatenate segments, so both need uniform tagging.
    for (const q of ["publish", "preview"] as SegmentQuality[]) {
      const still = await buildSegment(tmpDir, 7, jpegPath, "jpeg", q);
      const clip = await buildSegment(tmpDir, 8, webmPath, "webm", q);
      expect(await probeColourTags(still)).toEqual(EXPECTED);
      expect(await probeColourTags(clip)).toEqual(EXPECTED);
    }
  }, 300_000);
});
