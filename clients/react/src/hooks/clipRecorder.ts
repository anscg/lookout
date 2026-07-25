import {
  MAX_WIDTH,
  MAX_HEIGHT,
  JPEG_QUALITY,
  CLIP_VIDEO_BITS_PER_SECOND,
  type CaptureFormat,
} from "@lookout/shared";

/** One finalized per-minute clip, ready for the upload pipeline. */
export interface ClipCaptureResult {
  blob: Blob;
  format: Exclude<CaptureFormat, "jpeg">;
  width: number;
  height: number;
  /** Frames drawn into the clip. Informational — the server/worker derive
   *  the real count by demuxing. */
  frameCount: number;
  /** Client-clock ms timestamp stamped at cut time — the clip's capture
   *  moment for credit-mode purposes (one clip = one capture unit). */
  capturedAtMs: number;
  /** JPEG snapshot of the clip's last frame, for the UI preview only. */
  previewBlob: Blob | null;
}

interface MimeCandidate {
  mime: string;
  format: Exclude<CaptureFormat, "jpeg">;
}

/** Preference order: VP9 (best compression) → VP8 → generic WebM →
 *  MP4/H.264 (Safari — its MediaRecorder does not do WebM). */
const MIME_CANDIDATES: MimeCandidate[] = [
  { mime: "video/webm;codecs=vp9", format: "webm" },
  { mime: "video/webm;codecs=vp8", format: "webm" },
  { mime: "video/webm", format: "webm" },
  { mime: "video/mp4", format: "mp4" },
];

function pickMimeCandidate(): MimeCandidate | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      // isTypeSupported can throw on exotic UAs — treat as unsupported
    }
  }
  return null;
}

/** Per-recorder display knobs. Cadence and bitrate are deliberately NOT
 *  options: the frame interval is server-authoritative (constructor arg,
 *  from the session response) and the bitrate is the shared constant. */
export interface ClipRecorderOptions {
  maxWidth?: number;
  maxHeight?: number;
  jpegQuality?: number;
  /** Faster cadence for the FIRST clip only. The opening clip is cut
   *  after ~2 frame intervals (fast session activation), so at the normal
   *  cadence it would hold just 2 frames — one near-still second at the
   *  head of every timelapse. A denser opening cadence fixes that; after
   *  the first cut the recorder reverts to `frameIntervalMs`. */
  openingFrameIntervalMs?: number;
}

/**
 * Records the shared screen into per-minute video clips.
 *
 * Owns an offscreen canvas fed from the caller's `<video>` (the
 * getDisplayMedia sink) every `frameIntervalMs`, streamed through
 * `canvas.captureStream()` into a bitrate-capped MediaRecorder. `cut()`
 * finalizes the current clip and immediately starts the next one, so the
 * serial per-minute upload pipeline stays exactly as it is for JPEGs — a
 * clip is one capture unit.
 *
 * Clips are VFR: on a static screen the encoder legitimately emits few
 * frames. That's fine — the worker demuxes and normalizes each clip to
 * one second of output video regardless of frame count.
 */
export class ClipRecorder {
  private video: HTMLVideoElement;
  private frameIntervalMs: number;
  private openingFrameIntervalMs: number | null;
  private canvas: HTMLCanvasElement | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private frameCount = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private mime: MimeCandidate;
  // Opening cadence lives in its own field (cleared after the first cut),
  // so it's excluded from the always-resolved options.
  private opts: Required<Omit<ClipRecorderOptions, "openingFrameIntervalMs">>;

  static isSupported(): boolean {
    return (
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function" &&
      pickMimeCandidate() !== null
    );
  }

  constructor(
    video: HTMLVideoElement,
    frameIntervalMs: number,
    opts?: ClipRecorderOptions,
  ) {
    const mime = pickMimeCandidate();
    if (!mime) throw new Error("Clip recording not supported in this browser");
    this.video = video;
    this.frameIntervalMs = frameIntervalMs;
    this.openingFrameIntervalMs = opts?.openingFrameIntervalMs ?? null;
    this.mime = mime;
    this.opts = {
      maxWidth: opts?.maxWidth ?? MAX_WIDTH,
      maxHeight: opts?.maxHeight ?? MAX_HEIGHT,
      jpegQuality: opts?.jpegQuality ?? JPEG_QUALITY,
    };
  }

  /** Start recording a fresh clip. No-op if already recording. */
  start(): void {
    if (this.recorder) return;
    if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
      throw new Error("Video not ready — cannot start clip recorder");
    }

    const scale = Math.min(
      this.opts.maxWidth / this.video.videoWidth,
      this.opts.maxHeight / this.video.videoHeight,
      1,
    );
    const canvas = document.createElement("canvas");
    // Encoder-friendly even dimensions; the size is fixed for the clip's
    // life (MediaRecorder requires a constant stream resolution).
    canvas.width = Math.max(2, Math.round((this.video.videoWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((this.video.videoHeight * scale) / 2) * 2);
    this.canvas = canvas;

    // captureStream(0) = frames only on explicit requestFrame(), keeping
    // encode work at exactly our cadence. Some engines put requestFrame on
    // the track (spec), others on the stream (older Firefox), some lack it
    // entirely — fall back to auto-capture on canvas change.
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(0);
      if (!this.streamHasRequestFrame(stream)) {
        stream.getTracks().forEach((t) => t.stop());
        stream = canvas.captureStream();
      }
    } catch {
      stream = canvas.captureStream();
    }
    this.stream = stream;

    this.parts = [];
    this.frameCount = 0;
    const recorder = new MediaRecorder(stream, {
      mimeType: this.mime.mime,
      videoBitsPerSecond: CLIP_VIDEO_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.parts.push(e.data);
    };
    this.recorder = recorder;
    recorder.start();

    this.drawFrame();
    const cadence = this.openingFrameIntervalMs ?? this.frameIntervalMs;
    this.frameTimer = setInterval(() => this.drawFrame(), cadence);
  }

  private streamHasRequestFrame(stream: MediaStream): boolean {
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
      requestFrame?: () => void;
    };
    const s = stream as MediaStream & { requestFrame?: () => void };
    return (
      typeof track?.requestFrame === "function" ||
      typeof s.requestFrame === "function"
    );
  }

  private drawFrame(): void {
    const canvas = this.canvas;
    if (!canvas || this.video.videoWidth === 0 || this.video.videoHeight === 0)
      return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const track = this.stream?.getVideoTracks()[0] as
      | (MediaStreamTrack & { requestFrame?: () => void })
      | undefined;
    if (typeof track?.requestFrame === "function") {
      track.requestFrame();
    } else {
      (
        this.stream as (MediaStream & { requestFrame?: () => void }) | null
      )?.requestFrame?.();
    }
    this.frameCount++;
  }

  /**
   * Finalize the current clip and immediately start the next one.
   * Returns null when the clip is unusable (no frames / empty blob) —
   * callers should fall back to a single-JPEG capture for that tick.
   */
  async cut(): Promise<ClipCaptureResult | null> {
    const recorder = this.recorder;
    const canvas = this.canvas;
    if (!recorder || !canvas) return null;

    // Final frame + timestamp: capturedAt is the moment the clip is cut,
    // which is what keeps the per-minute credit cadence monotonic.
    this.drawFrame();
    const capturedAtMs = Date.now();
    const frameCount = this.frameCount;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => resolve();
    });
    try {
      recorder.stop();
    } catch {
      // stop() throws if already inactive — treat as stopped
    }
    // Never let a wedged encoder stall the capture loop.
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    const parts = this.parts;
    const width = canvas.width;
    const height = canvas.height;
    const previewBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", this.opts.jpegQuality);
      setTimeout(() => resolve(null), 5_000);
    });

    // Tear down and restart for the next minute. The opening cadence only
    // ever applies to the first clip — every later interval is full-length.
    this.openingFrameIntervalMs = null;
    this.teardown();
    try {
      this.start();
    } catch {
      // Video may be momentarily not-ready; the caller's next tick falls
      // back to JPEG and recording resumes when start() next succeeds.
    }

    if (parts.length === 0 || frameCount === 0) return null;
    const blob = new Blob(parts, { type: this.mime.mime.split(";")[0] });
    if (blob.size === 0) return null;

    return {
      blob,
      format: this.mime.format,
      width,
      height,
      frameCount,
      capturedAtMs,
      previewBlob,
    };
  }

  /** Stop and discard the in-progress clip (pause/stop/unmount). */
  stop(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
    } catch {
      // already inactive
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.canvas = null;
    this.parts = [];
    this.frameCount = 0;
  }
}
