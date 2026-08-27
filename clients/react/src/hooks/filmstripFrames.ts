/** Where the editor's filmstrip gets its pixels.
 *
 * Two interchangeable sources behind one interface:
 *
 *   - `video`: seek a detached `<video>` and `drawImage` it. Cheap — it
 *     streams the presigned URL and decodes only the frames asked for —
 *     and it is what every engine except WebKitGTK does correctly.
 *   - `webcodecs`: download the file and run it through `VideoDecoder`
 *     (see mp4Frames.ts). Costs the whole preview up front, and works
 *     where reading a `<video>` doesn't.
 *
 * Both are tried, in the order `prefersDecoderFrames` decides, and every
 * drawn tile is checked before it is shown: a source that hands back frames
 * which cannot be real video gets abandoned rather than displayed. That
 * check is the backstop, not the fix — on the engine that actually has
 * this bug the decoder is tried first.
 */

import { Mp4FrameSource } from "./mp4Frames.js";

/** Why a drawn tile can't be a real frame. */
export type FrameFault =
  /** Nothing arrived: fully transparent, or one flat colour. */
  | "blank"
  /** Pixel-to-pixel hash — graphics memory that was never a frame read as
   *  if it were one. The "colourful static" filmstrip. */
  | "noise";

export type DrawResult = "ok" | FrameFault | "failed";

/** Luma spread at or under which a tile counts as one flat colour. Two
 *  levels, not zero: JPEG-free canvas draws are exact, but a downscale of
 *  a genuinely flat frame can still wobble by a hair. */
const FLAT_SPREAD = 2;
/** Mean luma step between horizontally adjacent pixels above which a tile
 *  is hash rather than picture. Independent random bytes average ~85 here;
 *  a downscaled screenshot, dense text and all, measures nearer 3 and
 *  should not reach 30. Set between the two but nearer the noise end,
 *  because a false positive costs the user their filmstrip.
 *
 *  This catches full-entropy garbage only. Read-back of an unmapped video
 *  surface returns whatever was in that memory, and measurement on
 *  WebKitGTK put that anywhere from a flat empty buffer to hash to
 *  something smooth enough to pass — which is why the fix for that engine
 *  is `prefersDecoderFrames`, not this check. */
const NOISE_STEP = 55;
/** A seek that never completes means the media pipeline is wedged; give up
 *  on the source rather than stalling the strip behind it. */
const SEEK_TIMEOUT_MS = 4000;

/** Pixels to look at per tile. Tiles are ~200×112, so this is usually all
 *  of them; the cap only matters if STRIP_HEIGHT ever grows. */
const FAULT_SAMPLE_BUDGET = 24_000;

/**
 * Judge a drawn tile on its pixels alone. Null when it looks like video.
 *
 * Deliberately conservative in both directions: it has to catch a source
 * that is returning nothing at all (the common case, and unmistakable),
 * without ever rejecting a real frame that happens to be dark or busy.
 */
export function frameFault(
  px: Uint8ClampedArray,
  width: number,
  height: number,
): FrameFault | null {
  if (width < 2 || height < 1) return null;
  const rowStep = Math.max(1, Math.ceil((width * height) / FAULT_SAMPLE_BUDGET));
  let min = 255;
  let max = 0;
  let opaque = 0;
  let seen = 0;
  let stepSum = 0;
  let steps = 0;

  for (let y = 0; y < height; y += rowStep) {
    const row = y * width * 4;
    let prev = -1;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      const luma = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      if (px[i + 3] > 0) opaque++;
      seen++;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
      if (prev >= 0) {
        stepSum += Math.abs(luma - prev);
        steps++;
      }
      prev = luma;
    }
  }

  if (!seen) return null;
  // Nothing was painted: the canvas is still the transparent black it was
  // cleared to. This is what WebKitGTK's accelerated path produces.
  if (opaque === 0) return "blank";
  if (max - min <= FLAT_SPREAD) return "blank";
  if (steps > 0 && stepSum / steps >= NOISE_STEP) return "noise";
  return null;
}

/** A source of stills for the filmstrip. */
export interface FilmstripFrames {
  readonly kind: "webcodecs" | "video";
  /** Frame width ÷ height, which sets the tile width. */
  readonly aspect: number;
  readonly durationSec: number;
  /** Draw the frame at `timeSec` filling the context's canvas. */
  draw(
    timeSec: number,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): Promise<DrawResult>;
  close(): void;
}

/** Draw whatever was produced, then check it. Shared by both sources so
 *  the two can't disagree about what counts as a usable tile. */
function drawAndJudge(
  source: CanvasImageSource,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): DrawResult {
  ctx.clearRect(0, 0, width, height);
  try {
    ctx.drawImage(source, 0, 0, width, height);
  } catch (err) {
    console.warn("[filmstrip] drawImage failed:", err);
    return "failed";
  }
  let px: Uint8ClampedArray;
  try {
    px = ctx.getImageData(0, 0, width, height).data;
  } catch {
    // A tainted canvas can't be read — but it also can't be turned into a
    // data URL, so this source is unusable either way.
    return "failed";
  }
  return frameFault(px, width, height) ?? "ok";
}

/** WebCodecs over the file's bytes. Null when the container or the engine
 *  won't cooperate. */
export async function openDecoderFrames(
  bytes: ArrayBuffer,
): Promise<FilmstripFrames | null> {
  const src = await Mp4FrameSource.open(bytes);
  if (!src) return null;
  return {
    kind: "webcodecs",
    aspect: src.width / Math.max(1, src.height),
    durationSec: src.durationSec,
    async draw(timeSec, ctx, width, height) {
      const frame = await src.frameAt(timeSec);
      if (!frame) return "failed";
      try {
        return drawAndJudge(frame, ctx, width, height);
      } finally {
        frame.close();
      }
    },
    close: () => src.close(),
  };
}

/** A detached `<video>`, seeked per tile. `url` must be same-origin or
 *  CORS-readable, otherwise the canvas is tainted and every tile fails. */
export async function openVideoFrames(
  url: string,
  opts: { crossOrigin?: boolean } = {},
): Promise<FilmstripFrames | null> {
  if (typeof document === "undefined") return null;
  const el = document.createElement("video");
  if (opts.crossOrigin) el.crossOrigin = "anonymous";
  el.muted = true;
  el.preload = "auto";
  el.src = url;

  const dispose = () => {
    el.removeAttribute("src");
    el.load();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error("video load failed"));
    });
  } catch (err) {
    console.warn("[filmstrip] frame video would not load:", err);
    dispose();
    return null;
  }
  if (!el.videoWidth || !el.videoHeight) {
    dispose();
    return null;
  }

  return {
    kind: "video",
    aspect: el.videoWidth / el.videoHeight,
    durationSec: el.duration,
    async draw(timeSec, ctx, width, height) {
      // Nudge off an exact match: assigning the current time is a no-op
      // and `seeked` would never fire, hanging the strip.
      const want = Math.max(0, Math.min(el.duration - 0.05, timeSec));
      if (Math.abs(el.currentTime - want) > 1e-3) {
        const seeked = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), SEEK_TIMEOUT_MS);
          el.onseeked = () => {
            clearTimeout(timer);
            resolve(true);
          };
          el.currentTime = want;
        });
        if (!seeked) return "failed";
      }
      return drawAndJudge(el, ctx, width, height);
    },
    close: dispose,
  };
}

/**
 * Whether to reach for the decoder before trying to read a `<video>`.
 *
 * True on WebKitGTK, where reading a `<video>` into a canvas returns empty
 * or garbage frames whenever accelerated compositing is on (see
 * mp4Frames.ts). Trying it there would only cost the user a visibly
 * delayed filmstrip before the fault check gave up on it.
 *
 * Narrow on purpose. WebKitGTK is the Linux port of WebKit, so: an
 * AppleWebKit engine string, on Linux, that is neither a Chromium
 * (Chrome/Edge, which also claim AppleWebKit) nor Android. Everything
 * else — desktop Safari, Chrome, Firefox, iOS — reads video fine and
 * keeps the cheaper source.
 */
export function prefersDecoderFrames(
  ua = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return (
    /AppleWebKit/.test(ua) &&
    /\bLinux\b/.test(ua) &&
    !/Chrom(e|ium)|Android|Mac OS X/.test(ua)
  );
}
