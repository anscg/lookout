import {
  MAX_WIDTH,
  MAX_HEIGHT,
  JPEG_QUALITY,
  CLIP_WEB_VIDEO_BITS_PER_SECOND,
  CLIP_WEB_MIN_BITS_PER_SECOND,
  MAX_CLIP_FRAME_OVERRUN,
  MAX_CLIP_BYTES,
  SCREENSHOT_INTERVAL_MS,
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
  /** True when the clip hit its frame cap, i.e. the window it covers ran
   *  long because the previous upload was still draining. The clip is
   *  still perfectly usable; the caller may want to log the stall. */
  truncated: boolean;
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

/** Preference order: H.264/MP4 first, WebM only as a fallback for engines
 *  that cannot record MP4 (Firefox).
 *
 *  This is the opposite of what raw compression efficiency suggests, and
 *  it is deliberate. Our content is sparse 1080p screen frames, which is
 *  exactly where the browsers' realtime libvpx configuration falls apart.
 *  Measured at matched output size (Chromium 148, 1080p, PSNR vs source):
 *
 *      ~115 KB/frame    H.264 30.9 dB    VP9 22.3 dB
 *      ~190 KB/frame    H.264 34.3 dB    VP9 24.7 dB
 *      ~335 KB/frame    H.264 38.6 dB    VP9 28.6 dB
 *
 *  H.264 is 8-10 dB better for the same bytes, and its quality is even
 *  across the clip, where VP9 spends nearly everything on the keyframe
 *  and leaves the other 14 frames soft. (VP8 is worse still: its rate
 *  control is inert below ~10 Mbps — identical bytes at 0.8M, 2M and 5M.)
 *  This mirrors the desktop app's own benchmarks, which rejected libvpx
 *  for the same workload.
 *
 *  The profile-specific strings come first so we get High profile where
 *  it is offered; bare "video/mp4" is the Safari path. */
const MIME_CANDIDATES: MimeCandidate[] = [
  { mime: "video/mp4;codecs=avc1.640028", format: "mp4" }, // H.264 High 4.0
  { mime: "video/mp4;codecs=avc1.4d0028", format: "mp4" }, // H.264 Main 4.0
  { mime: "video/mp4;codecs=avc1.42e01e", format: "mp4" }, // H.264 Baseline 3.0
  { mime: "video/mp4", format: "mp4" },
  { mime: "video/webm;codecs=vp9", format: "webm" },
  { mime: "video/webm;codecs=vp8", format: "webm" },
  { mime: "video/webm", format: "webm" },
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
  /** Faster cadence for the FIRST clip only. The opening clip is cut after
   *  CLIP_FIRST_CUT_DELAY_MS (fast session activation), which is shorter
   *  than one frame interval — so at the normal cadence it would hold a
   *  single frame. The compiler drops the seed unit from the video anyway,
   *  so this is about the recorder having something to show and something
   *  to upload, not about output quality. After the first cut the recorder
   *  reverts to `frameIntervalMs`. */
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
  /** Live encoder bitrate. Starts at the measured-optimal web rate and
   *  halves whenever a finished clip overruns MAX_CLIP_BYTES — see
   *  `cut()`. Browsers whose rate control does honour real frame spacing
   *  would otherwise blow the cap on every single clip. */
  private bitrate = CLIP_WEB_VIDEO_BITS_PER_SECOND;
  /** Hard frame cap for one clip — see MAX_CLIP_FRAME_OVERRUN. Derived from
   *  the SERVER's cadence, not the default constant, so a server that
   *  dictates a different frameIntervalMs still gets a correct cap. */
  private maxFrames: number;
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
    this.maxFrames =
      Math.ceil(SCREENSHOT_INTERVAL_MS / Math.max(1, frameIntervalMs)) *
      MAX_CLIP_FRAME_OVERRUN;
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
      videoBitsPerSecond: this.bitrate,
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
    // Frame cap. A clip is cut by its upload tick, so a slow uplink stretches
    // the window this clip covers — and every extra frame is more bytes
    // against MAX_CLIP_BYTES, for a clip that renders as one second either
    // way. Past the cap, stop feeding the encoder and stop the timer: the
    // clip stays uploadable, and we stop burning CPU compositing frames
    // nothing will ever see.
    if (this.frameCount >= this.maxFrames) {
      if (this.frameTimer) {
        clearInterval(this.frameTimer);
        this.frameTimer = null;
      }
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Only matters when the source is larger than the clip canvas, but a
    // bilinear-ish downscale of 1080p+ UI text aliases badly. The desktop
    // client area-averages for the same reason.
    ctx.imageSmoothingQuality = "high";
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
    const truncated = frameCount >= this.maxFrames;
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

    const blob =
      parts.length > 0 && frameCount > 0
        ? new Blob(parts, { type: this.mime.mime.split(";")[0] })
        : null;

    // Oversize clips are rejected server-side (HeadObject vs
    // MAX_CLIP_BYTES), which would cost the whole minute. We tune the
    // bitrate for the rate-control behaviour browsers actually have, so
    // this should never fire — but an engine that instead budgets over
    // the clip's real 60s wall clock would overshoot every time. Halve
    // and carry on rather than upload a clip we know will be refused;
    // the floor is the coarsest setting worth uploading.
    let oversize = false;
    if (blob && blob.size > MAX_CLIP_BYTES) {
      oversize = true;
      // ...but only when the clip was a NORMAL one. A truncated clip is
      // oversize because the network stalled and it covers several minutes,
      // not because the encoder is mis-tuned. The backoff is permanent
      // (bitrate never ratchets back up), so blaming the encoder for a
      // network event would leave the rest of the session soft — the exact
      // failure mode where a user on bad wifi ends up with a worse
      // timelapse than one on no wifi at all.
      const reduced = truncated
        ? this.bitrate
        : Math.max(CLIP_WEB_MIN_BITS_PER_SECOND, Math.round(this.bitrate / 2));
      if (reduced !== this.bitrate) {
        console.warn(
          `[lookout] clip was ${blob.size} bytes (cap ${MAX_CLIP_BYTES}) — ` +
            `dropping encoder bitrate ${this.bitrate} -> ${reduced}`,
        );
        this.bitrate = reduced;
      } else if (truncated) {
        console.warn(
          `[lookout] clip was ${blob.size} bytes (cap ${MAX_CLIP_BYTES}) after ` +
            `running long on a slow upload — keeping bitrate at ${this.bitrate}`,
        );
      }
    }

    // Tear down and restart for the next minute — after the size check, so
    // any backoff above applies to the clip we're about to start. The
    // opening cadence only ever applies to the first clip; every later
    // interval is full-length.
    this.openingFrameIntervalMs = null;
    this.teardown();
    try {
      this.start();
    } catch {
      // Video may be momentarily not-ready; the caller's next tick falls
      // back to JPEG and recording resumes when start() next succeeds.
    }

    // A null/empty/oversize clip falls back to a single JPEG for this
    // tick, so the capture cadence and credit streak never skip.
    if (!blob || blob.size === 0 || oversize) return null;

    return {
      blob,
      format: this.mime.format,
      width,
      height,
      frameCount,
      truncated,
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
