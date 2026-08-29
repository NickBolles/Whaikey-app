import { describe, expect, it } from "vitest";
import {
  AUTO_ID_MIN_INTERVAL_MS,
  AUTO_ID_QUIET_MS,
  BRIGHTNESS_MIN,
  MOVE_CLOSER_AFTER_MS,
  SCENE_CHANGE_MIN,
  captureWarning,
  frameLumas,
  frameStats,
  guidanceFor,
  lumaDelta,
  scaleBoxToCover,
  sceneFingerprint,
  shouldAutoId,
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

  it("never chases barcodes on a browser that can't decode them", () => {
    // Light and steadiness still coach; barcode-hunting hints do not.
    expect(guidanceFor({ brightness: 20, sharpness: 1 }, Infinity, false).message).toMatch(
      /too dark/i,
    );
    expect(guidanceFor(bright, Infinity, false).message).toMatch(/point at the label/i);
    expect(guidanceFor(bright, 100, false).message).toMatch(/point at the label/i);
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

describe("lumaDelta", () => {
  it("is zero for identical frames and grows with scene change", () => {
    const a = frameLumas(gray(8, 8, () => 100), 8, 8);
    const b = frameLumas(gray(8, 8, () => 100), 8, 8);
    const c = frameLumas(gray(8, 8, () => 180), 8, 8);
    expect(lumaDelta(a, b)).toBe(0);
    expect(lumaDelta(a, c)).toBeCloseTo(80, 0);
  });

  it("treats mismatched frame sizes as a full scene change", () => {
    const a = frameLumas(gray(8, 8, () => 100), 8, 8);
    const b = frameLumas(gray(4, 4, () => 100), 4, 4);
    expect(lumaDelta(a, b)).toBe(255);
  });
});

describe("sceneFingerprint", () => {
  const W = 64;
  const H = 48;

  it("tolerates a one-pixel handheld shift that raw luma deltas do not", () => {
    // Sharp vertical stripes — the worst case for per-pixel comparison.
    const stripes = (shift: number) => gray(W, H, (x) => ((x + shift) % 2 === 0 ? 250 : 30));
    const a = frameLumas(stripes(0), W, H);
    const b = frameLumas(stripes(1), W, H);
    // Raw pixels read the shift as a completely different frame…
    expect(lumaDelta(a, b)).toBeGreaterThan(SCENE_CHANGE_MIN);
    // …while block means barely move.
    expect(lumaDelta(sceneFingerprint(a, W, H), sceneFingerprint(b, W, H))).toBeLessThan(
      SCENE_CHANGE_MIN,
    );
  });

  it("still reads a genuinely different scene as changed", () => {
    const dark = sceneFingerprint(frameLumas(gray(W, H, () => 40), W, H), W, H);
    const bright = sceneFingerprint(frameLumas(gray(W, H, () => 160), W, H), W, H);
    expect(lumaDelta(dark, bright)).toBeGreaterThanOrEqual(SCENE_CHANGE_MIN);
  });
});

describe("shouldAutoId", () => {
  const goodFrame = { brightness: 150, sharpness: 40 };
  const ready = {
    msSinceDetection: AUTO_ID_QUIET_MS,
    msSinceLastId: Infinity,
    stats: goodFrame,
    sceneDelta: null,
  };

  it("fires on a good quiet frame with no prior read", () => {
    expect(shouldAutoId(ready)).toBe(true);
  });

  it("waits while barcodes are still being found", () => {
    expect(shouldAutoId({ ...ready, msSinceDetection: AUTO_ID_QUIET_MS - 1 })).toBe(false);
  });

  it("never spends an AI call on a dark or blurry frame", () => {
    expect(shouldAutoId({ ...ready, stats: null })).toBe(false);
    expect(shouldAutoId({ ...ready, stats: { brightness: 20, sharpness: 40 } })).toBe(false);
    expect(shouldAutoId({ ...ready, stats: { brightness: 150, sharpness: 1 } })).toBe(false);
  });

  it("paces reads and skips an unchanged scene", () => {
    expect(shouldAutoId({ ...ready, msSinceLastId: AUTO_ID_MIN_INTERVAL_MS - 1 })).toBe(false);
    expect(
      shouldAutoId({
        ...ready,
        msSinceLastId: AUTO_ID_MIN_INTERVAL_MS,
        sceneDelta: SCENE_CHANGE_MIN - 1,
      }),
    ).toBe(false);
    expect(
      shouldAutoId({
        ...ready,
        msSinceLastId: AUTO_ID_MIN_INTERVAL_MS,
        sceneDelta: SCENE_CHANGE_MIN,
      }),
    ).toBe(true);
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
