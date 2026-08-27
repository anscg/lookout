import { describe, expect, it } from "vitest";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { Mp4FrameSource, demuxMp4Video, nearestSample } from "./mp4Frames.js";

/** A plausible avcC: configurationVersion, then the profile/compat/level
 *  bytes the codec string is built from, then one SPS and one PPS. */
const AVCC = new Uint8Array([
  1, 0x64, 0x00, 0x28, 0xff,
  0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28,
  0x01, 0x00, 0x04, 0x68, 0xef, 0x84, 0x72,
]);

const FPS = 6;

/**
 * Mux a file shaped like the worker's preview tier: one H.264 track, a
 * keyframe every second, faststart. The payloads are not real H.264 — the
 * demuxer only has to find them — but each sample gets a distinct size and
 * fill byte so the offsets it reports can be checked against the bytes.
 */
function makeMp4(
  frames: number,
  opts: { width?: number; height?: number; gop?: number } = {},
): { bytes: ArrayBuffer; sizes: number[]; fills: number[] } {
  const { width = 1280, height = 720, gop = FPS } = opts;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });
  const sizes: number[] = [];
  const fills: number[] = [];
  for (let i = 0; i < frames; i++) {
    const size = 40 + i * 3;
    const fill = (i % 251) + 1;
    sizes.push(size);
    fills.push(fill);
    muxer.addVideoChunkRaw(
      new Uint8Array(size).fill(fill),
      i % gop === 0 ? "key" : "delta",
      Math.round((i * 1e6) / FPS),
      Math.round(1e6 / FPS),
      i === 0
        ? { decoderConfig: { codec: "avc1.640028", description: AVCC } }
        : undefined,
    );
  }
  muxer.finalize();
  return { bytes: target.buffer, sizes, fills };
}

describe("demuxMp4Video", () => {
  it("reads the track's shape out of a preview-shaped file", () => {
    const { bytes } = makeMp4(60);
    const track = demuxMp4Video(bytes);
    expect(track).not.toBeNull();
    expect(track!.width).toBe(1280);
    expect(track!.height).toBe(720);
    expect(track!.codec).toBe("avc1.640028");
    expect(Array.from(track!.description)).toEqual(Array.from(AVCC));
    expect(track!.samples).toHaveLength(60);
    expect(track!.durationSec).toBeCloseTo(10, 2);
  });

  it("reports offsets that point at the samples", () => {
    const { bytes, sizes, fills } = makeMp4(24);
    const track = demuxMp4Video(bytes)!;
    const view = new Uint8Array(bytes);
    track.samples.forEach((s, i) => {
      expect(s.size).toBe(sizes[i]);
      // Every byte of the sample, not just the first: an offset that is
      // off by a sample would still match on a single byte if two
      // neighbours happened to share a fill.
      const slice = view.subarray(s.offset, s.offset + s.size);
      expect(slice).toHaveLength(sizes[i]);
      expect(slice.every((b) => b === fills[i])).toBe(true);
    });
  });

  it("times samples off the media timescale", () => {
    const track = demuxMp4Video(makeMp4(18).bytes)!;
    track.samples.forEach((s, i) => {
      expect(s.time).toBeCloseTo(i / FPS, 3);
    });
  });

  it("marks the sync samples the encoder wrote", () => {
    const track = demuxMp4Video(makeMp4(18, { gop: 6 }).bytes)!;
    const syncs = track.samples.flatMap((s, i) => (s.sync ? [i] : []));
    expect(syncs).toEqual([0, 6, 12]);
  });

  it("keeps a non-16:9 frame size", () => {
    const track = demuxMp4Video(makeMp4(6, { width: 800, height: 1280 }).bytes)!;
    expect(track.width).toBe(800);
    expect(track.height).toBe(1280);
  });

  it("indexes samples by presentation time", () => {
    const track = demuxMp4Video(makeMp4(18).bytes)!;
    expect(Array.from(track.byTime)).toHaveLength(18);
    const times = Array.from(track.byTime, (i) => track.samples[i].time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns null rather than throwing on input it can't parse", () => {
    expect(demuxMp4Video(new ArrayBuffer(0))).toBeNull();
    expect(demuxMp4Video(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeNull();
    // A real file cut off before the sample tables.
    const { bytes } = makeMp4(30);
    expect(demuxMp4Video(bytes.slice(0, 24))).toBeNull();
  });
});

describe("Mp4FrameSource.open", () => {
  it("declines instead of throwing when the engine has no WebCodecs", async () => {
    // happy-dom has no VideoDecoder, which is also the state of any
    // browser too old for it — the editor must fall back, not crash.
    expect(typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder).toBe(
      "undefined",
    );
    await expect(Mp4FrameSource.open(makeMp4(12).bytes)).resolves.toBeNull();
  });
});

describe("nearestSample", () => {
  it("finds the sample shown at a time, and rounds to the nearer one", () => {
    const track = demuxMp4Video(makeMp4(30).bytes)!;
    expect(nearestSample(track, 0)).toBe(0);
    expect(nearestSample(track, 1)).toBe(FPS);
    // Just short of a frame's own time still picks that frame.
    expect(nearestSample(track, 2 / FPS - 0.01)).toBe(2);
    expect(nearestSample(track, 2 / FPS + 0.01)).toBe(2);
    // Off both ends, clamped to the ends.
    expect(nearestSample(track, -5)).toBe(0);
    expect(nearestSample(track, 999)).toBe(29);
  });

  it("searches presentation order, not decode order", () => {
    // Stand in a reordered track: decode order is I P B B, so `samples` is
    // not sorted by time and a bisection over it would miss.
    const track = demuxMp4Video(makeMp4(4, { gop: 4 }).bytes)!;
    const shown = [0, 0.5, 1 / 6, 1 / 3];
    track.samples.forEach((s, i) => {
      s.time = shown[i];
    });
    track.byTime.set(
      Int32Array.from(track.samples.keys()).sort(
        (a, b) => track.samples[a].time - track.samples[b].time,
      ),
    );
    expect(Array.from(track.byTime)).toEqual([0, 2, 3, 1]);
    expect(nearestSample(track, 0.02)).toBe(0);
    expect(nearestSample(track, 1 / 6)).toBe(2);
    expect(nearestSample(track, 1 / 3)).toBe(3);
    expect(nearestSample(track, 0.49)).toBe(1);
  });
});
