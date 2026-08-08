import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIP_FRAME_INTERVAL_MS,
  FRAMES_PER_CLIP,
  MAX_CLIP_FRAME_OVERRUN,
  MAX_CLIP_BYTES,
} from "@lookout/shared";
import { ClipRecorder } from "./clipRecorder.js";

/**
 * A clip is cut by its upload tick, not by a timer — so when uploads run
 * behind, the clip keeps recording. These tests pin the bound on that, which
 * is what stops a bad connection from turning into lost footage:
 *
 * uncapped, a multi-minute stall produced a clip with several times the
 * nominal frame count, which blew MAX_CLIP_BYTES and was refused server-side
 * — costing the entire window — while still only ever rendering as ONE
 * second of output video.
 */

/** Bytes the fake encoder emits per drawn frame — mid-range for 1080p at the
 *  measured web bitrate (see CLIP_WEB_VIDEO_BITS_PER_SECOND's table). */
const BYTES_PER_FRAME = 300_000;

let framesRequested = 0;

class FakeMediaRecorder {
  static isTypeSupported = (mime: string) => mime === "video/mp4;codecs=avc1.640028";
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    _stream: MediaStream,
    public opts: { mimeType: string; videoBitsPerSecond: number },
  ) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // One blob sized to the frames the canvas actually pushed.
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(framesRequested * BYTES_PER_FRAME)]),
    });
    this.onstop?.();
  }
}

/** A <video>-alike with decoded dimensions, plus a canvas whose
 *  captureStream/getContext/toBlob are stubbed enough for the recorder. */
function fakeVideo(): HTMLVideoElement {
  return { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
}

beforeEach(() => {
  framesRequested = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
    const track = {
      requestFrame: () => {
        framesRequested++;
      },
      stop: () => {},
    };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    return {
      width: 0,
      height: 0,
      captureStream: () => stream,
      getContext: () => ({ drawImage: () => {}, imageSmoothingQuality: "" }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["preview"])),
    };
  }) as typeof document.createElement);
  // isSupported() probes for captureStream on the prototype; happy-dom has
  // no such method, and the recorder never calls the prototype's copy.
  (
    HTMLCanvasElement.prototype as unknown as { captureStream?: () => void }
  ).captureStream ??= () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clip frame cap", () => {
  it("stops recording frames once a stalled window hits the cap", async () => {
    const recorder = new ClipRecorder(fakeVideo(), CLIP_FRAME_INTERVAL_MS);
    recorder.start();

    const cap = FRAMES_PER_CLIP * MAX_CLIP_FRAME_OVERRUN;
    // Ten intervals' worth of frame ticks — a multi-minute upload stall.
    for (let i = 0; i < cap * 10; i++) {
      (recorder as unknown as { drawFrame(): void }).drawFrame();
    }

    const clip = await recorder.cut();
    expect(clip).not.toBeNull();
    expect(clip!.frameCount).toBeLessThanOrEqual(cap);
    expect(clip!.truncated).toBe(true);
    // The point of the cap: the clip is still small enough to be accepted.
    expect(clip!.blob.size).toBeLessThan(MAX_CLIP_BYTES);
    recorder.stop();
  });

  it("leaves a normal clip untruncated and uncapped", async () => {
    const recorder = new ClipRecorder(fakeVideo(), CLIP_FRAME_INTERVAL_MS);
    recorder.start();
    // start() draws one frame; add the rest of a nominal window.
    for (let i = 1; i < FRAMES_PER_CLIP; i++) {
      (recorder as unknown as { drawFrame(): void }).drawFrame();
    }

    const clip = await recorder.cut();
    expect(clip!.truncated).toBe(false);
    // The nominal window's frames plus the one cut() draws to close the clip
    // — the closing frame is also what capturedAt is stamped against.
    expect(clip!.frameCount).toBe(FRAMES_PER_CLIP + 1);
    recorder.stop();
  });

  it("keeps the encoder bitrate when an oversize clip was merely stalled", async () => {
    const recorder = new ClipRecorder(fakeVideo(), CLIP_FRAME_INTERVAL_MS);
    recorder.start();
    const before = (recorder as unknown as { bitrate: number }).bitrate;

    // Force the clip over the byte cap by making each frame enormous, and
    // over the frame cap so it registers as stalled rather than mis-tuned.
    const cap = FRAMES_PER_CLIP * MAX_CLIP_FRAME_OVERRUN;
    for (let i = 0; i < cap * 2; i++) {
      (recorder as unknown as { drawFrame(): void }).drawFrame();
    }
    (recorder as unknown as { maxFrames: number }).maxFrames = 1;

    await recorder.cut();
    // The backoff is permanent, so charging a network stall to the encoder
    // would leave the rest of the session soft.
    expect((recorder as unknown as { bitrate: number }).bitrate).toBe(before);
    recorder.stop();
  });
});
