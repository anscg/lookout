/** High-quality canvas downscale.
 *
 * A single `drawImage` shrink is bilinear in every engine (the
 * `imageSmoothingQuality` hint caps out well short of area averaging), and
 * bilinear sampling of a >2x shrink drops source pixels outright — which is
 * exactly what turns 5K Retina UI text into mush at 1080p. The desktop
 * client area-averages for the same reason (see capture.rs). Browsers have
 * no synchronous area filter, but repeatedly halving with bilinear
 * converges on the same result: every source pixel contributes to every
 * step, so nothing is skipped.
 */

// Shared scratch canvases for the intermediate halving steps — two, because
// consecutive steps ping-pong (a canvas can't be its own shrink source and
// destination without smearing). Capture is single-threaded and synchronous,
// so one pair serves however many recorders/paths are alive.
const scratch: (HTMLCanvasElement | null)[] = [null, null];

/**
 * Draw `src` (its full srcW×srcH extent) into `target` at the target's
 * current width/height, stepping through ≤2x shrinks. Falls back to the
 * plain single draw if a context is unavailable.
 */
export function drawScaledHQ(
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  target: HTMLCanvasElement,
): void {
  const ctx = target.getContext("2d");
  if (!ctx) return;

  let curSrc: CanvasImageSource = src;
  let curW = srcW;
  let curH = srcH;

  // Halve until one more bilinear step is a ≤2x shrink (or an upscale).
  let step = 0;
  while (curW / 2 >= target.width && curH / 2 >= target.height) {
    const nextW = Math.max(target.width, Math.floor(curW / 2));
    const nextH = Math.max(target.height, Math.floor(curH / 2));
    const dest = (scratch[step % 2] ??= document.createElement("canvas"));
    dest.width = nextW;
    dest.height = nextH;
    const dctx = dest.getContext("2d");
    if (!dctx) break; // give up on stepping; the final draw below still runs
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = "high";
    dctx.drawImage(curSrc, 0, 0, curW, curH, 0, 0, nextW, nextH);
    curSrc = dest;
    curW = nextW;
    curH = nextH;
    step++;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(curSrc, 0, 0, curW, curH, 0, 0, target.width, target.height);
}
