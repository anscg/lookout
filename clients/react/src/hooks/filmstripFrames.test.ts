import { describe, expect, it } from "vitest";
import { frameFault, prefersDecoderFrames } from "./filmstripFrames.js";

const W = 64;
const H = 32;

/** RGBA for a tile, painted by `pixel(x, y) -> [r, g, b, a?]`. */
function tile(
  pixel: (x: number, y: number) => [number, number, number, number?],
): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      const i = (y * W + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  return px;
}

/** Deterministic hash, standing in for whatever was in graphics memory. */
const hash = (n: number) => (Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 24) & 0xff;

describe("frameFault", () => {
  it("calls an untouched canvas blank", () => {
    // What a cleared canvas looks like when drawImage painted nothing:
    // every pixel still fully transparent.
    expect(frameFault(tile(() => [0, 0, 0, 0]), W, H)).toBe("blank");
  });

  it("calls a single flat colour blank, opaque or not", () => {
    expect(frameFault(tile(() => [0, 0, 0]), W, H)).toBe("blank");
    expect(frameFault(tile(() => [18, 18, 20]), W, H)).toBe("blank");
    expect(frameFault(tile(() => [255, 255, 255]), W, H)).toBe("blank");
  });

  it("calls per-pixel hash noise", () => {
    const px = tile((x, y) => {
      const n = y * W + x;
      return [hash(n), hash(n + 7919), hash(n + 104729)];
    });
    expect(frameFault(px, W, H)).toBe("noise");
  });

  it("passes a gradient", () => {
    expect(frameFault(tile((x, y) => [x * 4, y * 8, 128]), W, H)).toBeNull();
  });

  it("passes a dark frame that still has detail", () => {
    // A screen recording at night: nearly black, but not one colour.
    expect(frameFault(tile((x, y) => [2, (x + y) % 9, 3]), W, H)).toBeNull();
  });

  it("passes a busy frame — blocks of unrelated colour, as in a screenshot", () => {
    const px = tile((x, y) => {
      const block = ((y >> 2) * (W >> 2) + (x >> 2)) | 0;
      return [hash(block), hash(block + 31), hash(block + 61)];
    });
    expect(frameFault(px, W, H)).toBeNull();
  });

  it("has nothing to say about a degenerate tile", () => {
    expect(frameFault(new Uint8ClampedArray(4), 1, 1)).toBeNull();
    expect(frameFault(new Uint8ClampedArray(0), 0, 0)).toBeNull();
  });
});

describe("prefersDecoderFrames", () => {
  const WEBKITGTK =
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/60.5 Safari/605.1.15";

  it("is true on WebKitGTK, the engine that can't read a video", () => {
    expect(prefersDecoderFrames(WEBKITGTK)).toBe(true);
    // Tauri's Linux webview, which is WebKitGTK under another name.
    expect(
      prefersDecoderFrames(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) lookout/0.3.10",
      ),
    ).toBe(true);
  });

  it("is false on engines that read a video correctly", () => {
    const others = [
      // Chrome and Edge on Linux also claim AppleWebKit.
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/140.0.0.0 Safari/537.36",
      // Desktop Safari — WebKit, but not the GTK port.
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      // iOS, which says Mac OS X too.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      // Android says Linux.
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      // Firefox, no AppleWebKit at all.
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ];
    for (const ua of others) expect(prefersDecoderFrames(ua)).toBe(false);
  });

  it("is false when there is no user agent to go on", () => {
    expect(prefersDecoderFrames("")).toBe(false);
  });
});
