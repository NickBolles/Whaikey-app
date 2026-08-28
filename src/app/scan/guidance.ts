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
 * Mean |Δluma| between two sampled frames — how much the scene has changed.
 * Mismatched sizes count as a full scene change (camera restarted/rotated).
 */
export function lumaDelta(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
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
/** Mean |Δluma| below which the frame is "the same scene" as the last read. */
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
 */
export function guidanceFor(stats: FrameStats | null, msSinceDetection: number): Guidance {
  if (stats && stats.brightness < BRIGHTNESS_MIN) {
    return { kind: "warn", message: "Too dark — find more light" };
  }
  if (stats && stats.sharpness < SHARPNESS_MIN) {
    return { kind: "warn", message: "Hold steady…" };
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
