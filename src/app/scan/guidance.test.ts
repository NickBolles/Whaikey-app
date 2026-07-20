import { describe, expect, it } from "vitest";
import {
  BRIGHTNESS_MIN,
  MOVE_CLOSER_AFTER_MS,
  captureWarning,
  frameStats,
  guidanceFor,
  scaleBoxToCover,
} from "./guidance";

/** Build RGBA data for a WxH frame from a per-pixel gray-value function. */
function gray(width: number, height: number, value: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = value(x, y);
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return data;
}

describe("frameStats", () => {
  it("reads a dark flat frame as dark and soft", () => {
    const stats = frameStats(gray(8, 8, () => 20), 8, 8);
    expect(stats.brightness).toBeCloseTo(20, 0);
    expect(stats.sharpness).toBe(0);
  });

  it("reads a barcode-like stripe pattern as bright and sharp", () => {
    const stats = frameStats(gray(8, 8, (x) => (x % 2 === 0 ? 250 : 30)), 8, 8);
    expect(stats.brightness).toBeGreaterThan(100);
    expect(stats.sharpness).toBeGreaterThan(100);
  });
});

describe("guidanceFor", () => {
  const bright = { brightness: 150, sharpness: 40 };

  it("prioritizes light, then steadiness, then distance", () => {
    expect(guidanceFor({ brightness: 20, sharpness: 1 }, Infinity).message).toMatch(/too dark/i);
    expect(guidanceFor({ brightness: 150, sharpness: 1 }, Infinity).message).toMatch(/hold steady/i);
    expect(guidanceFor(bright, MOVE_CLOSER_AFTER_MS + 1).message).toMatch(/move closer/i);
  });

  it("falls back to the default framing hint", () => {
    expect(guidanceFor(bright, 100).message).toMatch(/center the barcode/i);
    expect(guidanceFor(null, 100).message).toMatch(/center the barcode/i);
  });
});

describe("captureWarning", () => {
  it("warns on dark or blurry captures, stays quiet otherwise", () => {
    expect(captureWarning({ brightness: BRIGHTNESS_MIN - 1, sharpness: 40 })).toMatch(/dark/i);
    expect(captureWarning({ brightness: 150, sharpness: 1 })).toMatch(/blurry/i);
    expect(captureWarning({ brightness: 150, sharpness: 40 })).toBeNull();
    expect(captureWarning(null)).toBeNull();
  });
});

describe("scaleBoxToCover", () => {
  it("maps video coordinates through object-cover scale and centering", () => {
    // 400×300 video shown in a 200×200 element: scale = 2/3, x is cropped.
    const box = scaleBoxToCover({ x: 100, y: 30, width: 60, height: 30 }, 400, 300, 200, 200);
    const scale = 200 / 300;
    expect(box.width).toBeCloseTo(60 * scale);
    expect(box.height).toBeCloseTo(30 * scale);
    expect(box.x).toBeCloseTo(100 * scale + (200 - 400 * scale) / 2);
    expect(box.y).toBeCloseTo(30 * scale);
  });

  it("degrades safely on a zero-sized video", () => {
    expect(scaleBoxToCover({ x: 1, y: 1, width: 1, height: 1 }, 0, 0, 100, 100)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
