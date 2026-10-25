/**
 * On-device label text recognition (M1 / Track A5).
 *
 * The free first pass of a label scan: the OS reads the text off the photo
 * — Apple Vision (`VNRecognizeTextRequest`) on iOS, ML Kit Text Recognition
 * on Android — and `/api/scan/label-text` matches the words against the
 * catalog. Only a low-confidence result falls back to the paid AI read
 * (`/api/scan-label`). On the web there is no engine, so `recognizeLabelText`
 * returns null and the caller goes straight to the AI read, as before.
 *
 * Why a custom plugin (`WhaikeyOcr`, in `ios/App/App/WhaikeyOcrPlugin.swift`
 * and `android/app/src/main/java/com/whaikey/app/WhaikeyOcrPlugin.kt`) rather
 * than `@capacitor-mlkit/text-recognition`: that package is CocoaPods-only on
 * iOS, and this project's iOS app is Swift-Package-Manager-based
 * (`ios/App/CapApp-SPM`). Vision ships with iOS, so the iOS side has no
 * dependency at all; Android uses the Play-services ML Kit model, which keeps
 * the APK small (the model downloads on demand).
 *
 * The plugin is registered from native code (not through `cap sync`), so it is
 * reached with `registerPlugin` and probed with `Capacitor.isPluginAvailable`.
 */
import { isNativeApp, loadPlugin } from "./platform";

export const OCR_PLUGIN = "WhaikeyOcr";

/** One recognized line; `height` is a fraction of the image height (0–1). */
export interface OcrLine {
  text: string;
  height?: number;
  confidence?: number;
}

export interface OcrResult {
  lines: OcrLine[];
  engine: "vision" | "mlkit";
}

/** What the native side resolves with. Kept loose: it is data from another runtime. */
interface RawOcrResponse {
  lines?: Array<{ text?: unknown; height?: unknown; confidence?: unknown }>;
  engine?: unknown;
}

interface WhaikeyOcrPlugin {
  recognizeText(options: { imageBase64: string }): Promise<RawOcrResponse>;
}

interface CapacitorProbe {
  isPluginAvailable?: (name: string) => boolean;
}

/** Whether this build carries the native OCR plugin. False on the web and on older shells. */
export function isOcrAvailable(): boolean {
  if (!isNativeApp()) return false;
  const cap = (window as { Capacitor?: CapacitorProbe }).Capacitor;
  try {
    return cap?.isPluginAvailable?.(OCR_PLUGIN) === true;
  } catch {
    return false;
  }
}

const clamp01 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;

/**
 * Validate and tidy a native response: drop empty lines, clamp numbers, cap
 * the count and line length to what `/api/scan/label-text` accepts. Pure, so
 * the shape contract with Swift/Kotlin is unit-tested here.
 */
export function normalizeOcrResponse(raw: RawOcrResponse | null | undefined, fallbackEngine: OcrResult["engine"]): OcrResult | null {
  if (!raw || !Array.isArray(raw.lines)) return null;
  const lines: OcrLine[] = [];
  for (const l of raw.lines) {
    if (!l || typeof l.text !== "string") continue;
    const text = l.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) continue;
    const line: OcrLine = { text };
    const height = clamp01(l.height);
    const confidence = clamp01(l.confidence);
    if (height !== undefined) line.height = height;
    if (confidence !== undefined) line.confidence = confidence;
    lines.push(line);
    if (lines.length >= 200) break;
  }
  if (lines.length === 0) return null;
  const engine = raw.engine === "vision" || raw.engine === "mlkit" ? raw.engine : fallbackEngine;
  return { lines, engine };
}

/** Strip a `data:image/...;base64,` prefix if present. */
export function base64Payload(dataUrlOrBase64: string): string {
  const comma = dataUrlOrBase64.indexOf(",");
  return dataUrlOrBase64.startsWith("data:") && comma >= 0 ? dataUrlOrBase64.slice(comma + 1) : dataUrlOrBase64;
}

/**
 * Read the text on a label photo, on the device. Resolves null — never throws —
 * when there is no engine (web, old shell), the read fails, or nothing legible
 * was found; the caller then uses the AI read.
 */
export async function recognizeLabelText(dataUrlOrBase64: string): Promise<OcrResult | null> {
  if (!isOcrAvailable()) return null;
  const plugin = await loadPlugin(async () => {
    const { registerPlugin } = await import("@capacitor/core");
    return registerPlugin<WhaikeyOcrPlugin>(OCR_PLUGIN);
  });
  if (!plugin) return null;
  try {
    const raw = await plugin.recognizeText({ imageBase64: base64Payload(dataUrlOrBase64) });
    const platform = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    return normalizeOcrResponse(raw, platform === "android" ? "mlkit" : "vision");
  } catch (err) {
    console.warn("[native] on-device OCR failed", err);
    return null;
  }
}
