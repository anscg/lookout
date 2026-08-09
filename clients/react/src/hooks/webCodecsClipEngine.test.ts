import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIP_WEBCODECS_QP } from "@lookout/shared";
import { WebCodecsClipEngine } from "./webCodecsClipEngine.js";

/**
 * Engine-level contract: frames in, standards-shaped MP4 out (via the real
 * mp4-muxer), quantizer mode preferred, and every failure surfaced as
 * `failed` + a null finish() rather than a throw — the recorder's fallback
 * ladder depends on that.
 */

/** Duck-typed EncodedVideoChunk. mp4-muxer type-checks with instanceof,
 *  so the class itself is installed as the global. */
class FakeEncodedVideoChunk {
  constructor(
    public type: "key" | "delta",
    public timestamp: number,
    public duration: number,
    private data: Uint8Array,
  ) {}
  get byteLength() {
    return this.data.byteLength;
  }
  copyTo(dest: Uint8Array) {
    dest.set(this.data);
  }
}

class FakeVideoFrame {
  closed = false;
  constructor(
    public source: unknown,
    public init: { timestamp: number; duration: number },
  ) {}
  close() {
    this.closed = true;
  }
}

interface EncodeCall {
  timestamp: number;
  keyFrame: boolean;
  quantizer: number | undefined;
}

let encodeCalls: EncodeCall[];
let supportedModes: string[];
let bytesPerChunk: number;
let erroring: boolean;

class FakeVideoEncoder {
  static isConfigSupported = vi.fn(
    async (config: { bitrateMode?: string; codec: string }) => ({
      supported:
        supportedModes.includes(config.bitrateMode ?? "") &&
        config.codec.startsWith("avc1."),
      config,
    }),
  );

  private emitted = 0;
  constructor(
    private callbacks: {
      output: (chunk: unknown, meta: unknown) => void;
      error: (err: Error) => void;
    },
  ) {}
  configure(_config: unknown) {}
  encode(frame: FakeVideoFrame, opts?: { keyFrame?: boolean; avc?: { quantizer?: number } }) {
    if (erroring) {
      this.callbacks.error(new Error("synthetic encoder failure"));
      return;
    }
    encodeCalls.push({
      timestamp: frame.init.timestamp,
      keyFrame: opts?.keyFrame ?? false,
      quantizer: opts?.avc?.quantizer,
    });
    const chunk = new FakeEncodedVideoChunk(
      opts?.keyFrame ? "key" : "delta",
      frame.init.timestamp,
      frame.init.duration,
      new Uint8Array(bytesPerChunk).fill(0xab),
    );
    // description only on the first chunk, like real encoders in avc mode.
    const meta =
      this.emitted++ === 0
        ? { decoderConfig: { description: new Uint8Array([1, 100, 0, 40, 0xff]) } }
        : {};
    this.callbacks.output(chunk, meta);
  }
  async flush() {}
  close() {}
}

const canvas = {} as HTMLCanvasElement;

beforeEach(() => {
  encodeCalls = [];
  supportedModes = ["quantizer", "variable"];
  bytesPerChunk = 1000;
  erroring = false;
  FakeVideoEncoder.isConfigSupported.mockClear();
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Configs are cached per dimensions+cadence — vary dims to avoid
 *  cross-test bleed through the module-level cache. */
let nextSize = 640;
function makeEngine(qp = CLIP_WEBCODECS_QP): WebCodecsClipEngine {
  nextSize += 2;
  return new WebCodecsClipEngine(nextSize, 360, 10_000, qp);
}

describe("WebCodecsClipEngine", () => {
  it("encodes frames at real media timestamps and muxes an MP4", async () => {
    const engine = makeEngine();
    engine.addFrame(canvas, 0, true);
    engine.addFrame(canvas, 10_000, false);
    engine.addFrame(canvas, 20_000, false);

    const out = await engine.finish();
    expect(engine.failed).toBe(false);
    expect(out).not.toBeNull();
    expect(out!.format).toBe("mp4");
    expect(out!.blob.type).toBe("video/mp4");
    // Container framing around 3 x bytesPerChunk of samples.
    expect(out!.blob.size).toBeGreaterThan(3 * bytesPerChunk);

    // Microsecond timestamps 10s apart — the thing MediaRecorder can't do.
    expect(encodeCalls.map((c) => c.timestamp)).toEqual([
      0, 10_000_000, 20_000_000,
    ]);
    expect(encodeCalls.map((c) => c.keyFrame)).toEqual([true, false, false]);
    // Quantizer mode was preferred and the recorder's QP flowed through.
    expect(encodeCalls.every((c) => c.quantizer === CLIP_WEBCODECS_QP)).toBe(
      true,
    );

    // The muxed bytes actually contain an MP4 file-type box.
    const head = new Uint8Array(await out!.blob.slice(0, 16).arrayBuffer());
    expect(String.fromCharCode(...head.subarray(4, 8))).toBe("ftyp");
  });

  it("falls back to variable bitrate when quantizer mode is unsupported", async () => {
    supportedModes = ["variable"];
    const engine = makeEngine();
    engine.addFrame(canvas, 0, true);

    const out = await engine.finish();
    expect(out).not.toBeNull();
    // No per-frame QP in VBR mode.
    expect(encodeCalls[0].quantizer).toBeUndefined();
  });

  it("fails soft when no config is supported", async () => {
    supportedModes = [];
    const engine = makeEngine();
    engine.addFrame(canvas, 0, true);

    const out = await engine.finish();
    expect(out).toBeNull();
    expect(engine.failed).toBe(true);
  });

  it("fails soft when the encoder errors mid-clip", async () => {
    erroring = true;
    const engine = makeEngine();
    engine.addFrame(canvas, 0, true);
    // Let the async init drain the pending frame into the erroring encoder.
    await Promise.resolve();
    await Promise.resolve();
    engine.addFrame(canvas, 10_000, false);

    const out = await engine.finish();
    expect(out).toBeNull();
    expect(engine.failed).toBe(true);
  });

  it("cancel() discards quietly without marking failure", async () => {
    const engine = makeEngine();
    engine.addFrame(canvas, 0, true);
    engine.cancel();
    expect(engine.failed).toBe(false);
  });
});
