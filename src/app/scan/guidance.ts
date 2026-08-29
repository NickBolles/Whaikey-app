/**
 * On-device scan guidance: everything here runs locally against camera
 * frames — no network, no model. The detect loop samples a downscaled frame,
 * derives brightness/sharpness, and turns that (plus how long it's been since
 * a barcode was last seen) into one short, actionable hint for the
 * viewfinder. Pure functions so the math is unit-testable without a canvas.
 */

export interface FrameStats {
  /** Mean luma, 0–255. */
  brightness: number;
  /** Mean absolute neighbor luma gradient — a cheap focus/blur proxy. */
  sharpness: number;
}

/** Below this mean luma the frame is too dark to decode reliably. */
export const BRIGHTNESS_MIN = 55;
/** Below this gradient energy the frame is likely motion-blurred/defocused. */
export const SHARPNESS_MIN = 6;
/** With no barcode seen for this long, nudge the user to move closer. */
export const MOVE_CLOSER_AFTER_MS = 6000;

/**
 * Compute brightness + sharpness from RGBA pixel data (a small downscaled
 * frame — 64×48 is plenty). Sharpness is the mean |Δluma| between horizontal
 * neighbors: crisp barcode edges score high, blur scores low.
 */
export function frameStats(data: Uint8ClampedArray, width: number, height: number): FrameStats {
  const lumas = frameLumas(data, width, height);
  let sum = 0;
  for (let i = 0; i < lumas.length; i++) sum += lumas[i];

  let grad = 0;
  let gradCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      grad += Math.abs(lumas[y * width + x] - lumas[y * width + x - 1]);
      gradCount++;
    }
  }
  return {
    brightness: sum / lumas.length,
    sharpness: gradCount > 0 ? grad / gradCount : 0,
  };
}

/** Per-pixel luma plane for a downscaled RGBA frame. */
export function frameLumas(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const lumas = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    lumas[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return lumas;
}

/**
 * Mean |Δluma| between two equal-length luma planes or fingerprints.
 * Mismatched sizes count as a full scene change (camera restarted/rotated).
 */
export function lumaDelta(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Scene fingerprint grid — coarse on purpose (see sceneFingerprint). */
const SCENE_GRID_W = 8;
const SCENE_GRID_H = 6;

/**
 * Motion-tolerant scene fingerprint: block-mean luma over a coarse grid.
 * Comparing raw luma planes is useless on a handheld camera — shifting a
 * sharp label by a single pixel changes per-pixel deltas by roughly the
 * frame's sharpness score, reading as a "new scene". An 8×8-pixel block's
 * mean barely moves under that shift, while a different bottle or
 * background moves most blocks — so fingerprints (compared via lumaDelta)
 * detect re-aiming, not hand tremor.
 */
export function sceneFingerprint(
  lumas: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const sums = new Float32Array(SCENE_GRID_W * SCENE_GRID_H);
  const counts = new Float32Array(SCENE_GRID_W * SCENE_GRID_H);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(SCENE_GRID_H - 1, Math.floor((y * SCENE_GRID_H) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(SCENE_GRID_W - 1, Math.floor((x * SCENE_GRID_W) / width));
      const i = gy * SCENE_GRID_W + gx;
      sums[i] += lumas[y * width + x];
      counts[i] += 1;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return sums;
}

// ---------------------------------------------------------------------------
// Live label ID pacing: when the barcode loop is coming up dry, the camera can
// read the label instead. These gates keep that automatic — but frugal: only a
// well-lit, steady frame is worth an AI call, and the same scene is never sent
// twice.
// ---------------------------------------------------------------------------

/** No barcode for this long before the label reader takes a turn. */
export const AUTO_ID_QUIET_MS = 2500;
/** Floor between automatic label reads, whatever the scene does. */
export const AUTO_ID_MIN_INTERVAL_MS = 8000;
/**
 * Mean |Δ| between scene fingerprints below which the frame is "the same
 * scene" as the last read. Fingerprint deltas, not raw luma deltas — see
 * sceneFingerprint for why.
 */
export const SCENE_CHANGE_MIN = 10;

export interface AutoIdSignals {
  /** ms since a barcode was last decoded (Infinity = never). */
  msSinceDetection: number;
  /** ms since the last automatic label read (Infinity = none yet). */
  msSinceLastId: number;
  stats: FrameStats | null;
  /** Scene change vs. the frame last sent for ID; null = nothing sent yet. */
  sceneDelta: number | null;
}

/** Whether this frame earns an automatic label-read. */
export function shouldAutoId(s: AutoIdSignals): boolean {
  if (!s.stats) return false;
  if (s.stats.brightness < BRIGHTNESS_MIN || s.stats.sharpness < SHARPNESS_MIN) return false;
  if (s.msSinceDetection < AUTO_ID_QUIET_MS) return false;
  if (s.msSinceLastId < AUTO_ID_MIN_INTERVAL_MS) return false;
  if (s.sceneDelta !== null && s.sceneDelta < SCENE_CHANGE_MIN) return false;
  return true;
}

export type GuidanceKind = "ok" | "hint" | "warn";

export interface Guidance {
  kind: GuidanceKind;
  message: string;
}

/**
 * One hint at a time, most-fixable first: light before steadiness before
 * distance. `msSinceDetection` is Infinity when nothing was ever detected.
 * `barcodeCapable` is false where no barcode detector exists (Safari,
 * Firefox) — the camera then only feeds the label reader, so barcode-chasing
 * hints would send the user on a fool's errand.
 */
export function guidanceFor(
  stats: FrameStats | null,
  msSinceDetection: number,
  barcodeCapable = true,
): Guidance {
  if (stats && stats.brightness < BRIGHTNESS_MIN) {
    return { kind: "warn", message: "Too dark — find more light" };
  }
  if (stats && stats.sharpness < SHARPNESS_MIN) {
    return { kind: "warn", message: "Hold steady…" };
  }
  if (!barcodeCapable) {
    return { kind: "hint", message: "Point at the label — Whaikey reads it automatically" };
  }
  if (msSinceDetection >= MOVE_CLOSER_AFTER_MS) {
    return { kind: "hint", message: "Move closer — fill the frame with the barcode" };
  }
  return { kind: "hint", message: "Center the barcode, or shutter for the label" };
}

/** Capture-quality verdict for the framing-confirm sheet (null = looks fine). */
export function captureWarning(stats: FrameStats | null): string | null {
  if (!stats) return null;
  if (stats.brightness < BRIGHTNESS_MIN) return "Looks dark — more light will read better.";
  if (stats.sharpness < SHARPNESS_MIN) return "Looks blurry — a retake will read better.";
  return null;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map a barcode bounding box from video-pixel coordinates onto the on-screen
 * element, accounting for `object-cover` cropping (the video is scaled to
 * fill and center-cropped, so both axes share one scale factor and the
 * overflow is split evenly).
 */
export function scaleBoxToCover(
  box: Box,
  videoW: number,
  videoH: number,
  elemW: number,
  elemH: number,
): Box {
  if (videoW <= 0 || videoH <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.max(elemW / videoW, elemH / videoH);
  const offsetX = (elemW - videoW * scale) / 2;
  const offsetY = (elemH - videoH * scale) / 2;
  return {
    x: box.x * scale + offsetX,
    y: box.y * scale + offsetY,
    width: box.width * scale,
    height: box.height * scale,
  };
}
