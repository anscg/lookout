import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stepped downscale is what keeps Retina text legible: a single
 * bilinear drawImage of a >2x shrink skips source pixels. These tests pin
 * the shape of the stepping — every draw must be a ≤2x shrink.
 */

interface DrawCall {
  srcW: number;
  srcH: number;
  dstW: number;
  dstH: number;
}

function fakeCanvas(calls: DrawCall[]): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
      drawImage: (
        _src: unknown,
        _sx: number,
        _sy: number,
        sw: number,
        sh: number,
        _dx: number,
        _dy: number,
        dw: number,
        dh: number,
      ) => {
        calls.push({ srcW: sw, srcH: sh, dstW: dw, dstH: dh });
      },
    }),
  };
  return canvas as unknown as HTMLCanvasElement;
}

let calls: DrawCall[];

beforeEach(() => {
  calls = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
    return fakeCanvas(calls);
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
  // The module caches scratch canvases; drop the module so the next test's
  // mocks are the ones that get cached.
  vi.resetModules();
});

async function drawScaledHQ(
  src: unknown,
  srcW: number,
  srcH: number,
  target: HTMLCanvasElement,
) {
  const mod = await import("./hqScale.js");
  mod.drawScaledHQ(src as CanvasImageSource, srcW, srcH, target);
}

describe("drawScaledHQ", () => {
  it("steps a 5K -> 1080p shrink so no draw exceeds 2x", async () => {
    const target = fakeCanvas(calls);
    target.width = 1920;
    target.height = 1080;

    await drawScaledHQ({}, 5120, 2880, target);

    // 5120x2880 -> 2560x1440 (halve) -> 1920x1080 (final 1.33x)
    expect(calls).toEqual([
      { srcW: 5120, srcH: 2880, dstW: 2560, dstH: 1440 },
      { srcW: 2560, srcH: 1440, dstW: 1920, dstH: 1080 },
    ]);
    for (const c of calls) {
      expect(c.srcW / c.dstW).toBeLessThanOrEqual(2);
      expect(c.srcH / c.dstH).toBeLessThanOrEqual(2);
    }
  });

  it("draws once when the source already fits", async () => {
    const target = fakeCanvas(calls);
    target.width = 1920;
    target.height = 1080;

    await drawScaledHQ({}, 1920, 1080, target);

    expect(calls).toEqual([
      { srcW: 1920, srcH: 1080, dstW: 1920, dstH: 1080 },
    ]);
  });

  it("keeps halving on very large sources (8K)", async () => {
    const target = fakeCanvas(calls);
    target.width = 1920;
    target.height = 1080;

    await drawScaledHQ({}, 7680, 4320, target);

    // 7680 -> 3840 -> 1920(final)
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.srcW / c.dstW).toBeLessThanOrEqual(2);
    }
    expect(calls[calls.length - 1]).toMatchObject({ dstW: 1920, dstH: 1080 });
  });
});
