"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollLock } from "@/lib/scroll-lock";
import Link from "next/link";
import {
  Aperture,
  Camera,
  Check,
  Flashlight,
  FlashlightOff,
  GlassWater,
  ImageUp,
  Keyboard,
  Loader2,
  RefreshCw,
  ScanLine,
  Sparkles,
  SwitchCamera,
  Undo2,
  X,
} from "lucide-react";
import { RELATIONSHIPS, type Relationship } from "@/db/schema";
import { isValidUpc, normalizeUpc } from "@/lib/upc";
import type { BottleSearchResult } from "@/lib/ai/tools";
import { CategoryChip } from "@/components/category-chip";
import { haptic } from "@/lib/native/haptics";
import { isNativeApp } from "@/lib/native/platform";
import { originLabel } from "@/lib/origin";
import {
  isNativeTorchAvailable,
  setNativeTorch,
  startNativeScan,
  type NativeScanSession,
} from "@/lib/native/barcode";
import {
  BRIGHTNESS_MIN,
  captureWarning,
  frameLumas,
  frameStats,
  guidanceFor,
  lumaDelta,
  SCENE_CHANGE_MIN,
  scaleBoxToCover,
  shouldAutoId,
  type Box,
  type FrameStats,
  type Guidance,
} from "./guidance";

/**
 * Rapid-fire scanning built around an async capture queue: every barcode hit,
 * typed code, or label photo becomes a queue item that resolves in the
 * background while you keep scanning. Unique matches shelve themselves;
 * ambiguous ones pile up as "needs you" items you can settle after the last
 * bottle is back on the shelf. Dual-mode camera: the barcode loop runs
 * continuously, and when it comes up dry on a good frame the live label
 * reader takes a turn — an automatic AI read (paced and scene-gated in
 * guidance.ts) that surfaces one-tap suggestions in realtime. The shutter
 * remains for a deliberate framed shot; a clean capture goes straight into
 * the queue, and only a dark/blurry one asks for confirmation first.
 *
 * Two scanning engines sit behind one UI (docs/NATIVE_APP.md §3.1): inside the
 * native shell, MLKit renders the camera behind the WebView and pushes barcodes
 * up through the plugin; on the web we fall back to the `BarcodeDetector` loop
 * over a `<video>` element. The web engine is Chromium-only — WKWebView has no
 * `BarcodeDetector` at all — so the native engine is what makes scanning work on
 * iPhone. The queue, review sheet, and label-capture flows are shared.
 */

interface UpcMatch extends BottleSearchResult {
  confirmedCount?: number;
}

interface ScanResponse {
  upc: string;
  matches: UpcMatch[];
  candidates: BottleSearchResult[];
  externalName: string | null;
}

type ItemStatus = "resolving" | "added" | "review" | "failed";

interface AddedInfo {
  userBottleId: string | null;
  bottleId: string;
  name: string;
  relationship: Relationship;
  updated: boolean;
}

interface QueueItem {
  id: string;
  kind: "upc" | "label";
  /** Normalized GTIN for barcode items; carried into label confirms so a rescue teaches the mapping. */
  upc: string | null;
  /** Tiny preview for label items. */
  thumb: string | null;
  status: ItemStatus;
  /** Review-sheet payload when status is "review". */
  title: string;
  subtitle: string | null;
  options: BottleSearchResult[];
  added: AddedInfo | null;
}

interface Capture {
  dataUrl: string;
  mediaType: string;
  /** When set, the confirmed photo resolves THIS item instead of enqueueing a new one. */
  forItemId: string | null;
  /** On-device quality verdict shown in the confirm sheet (null = looks fine). */
  warning: string | null;
}

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  own: "I own it",
  tried: "Tried it",
  wishlist: "Wishlist",
};

// Minimal typings for the (Chromium-only, for now) shape-detection API.
interface DetectedBarcode {
  rawValue: string;
  format?: string;
  boundingBox?: Box;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

type CameraTrack = Pick<MediaStreamTrack, "applyConstraints"> & {
  getCapabilities?: () => { torch?: boolean; focusMode?: string[] };
};

/**
 * Retail GTIN symbologies plus the ones whiskey actually wears: ITF-14 on
 * gift boxes/cases and Code 128 GTINs on craft bottlings. Non-GTIN payloads
 * are filtered out by UPC validation before they reach the queue.
 */
const BARCODE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8", "itf", "code_128"];
const RETAIL_FORMATS = new Set(["upc_a", "upc_e", "ean_13", "ean_8"]);
/** Ignore re-detections of the same code within this window (ms). */
const REPEAT_MS = 4000;
const DETECT_INTERVAL_MS = 300;
/** Longest edge for uploaded label captures. */
const CAPTURE_MAX_PX = 1280;
/** Longest edge for automatic live-ID frames (smaller: they're frequent). */
const LIVE_ID_MAX_PX = 1024;

/** Downscale the current video frame to a JPEG data URL (null = not ready). */
function frameDataUrl(video: HTMLVideoElement, maxPx: number): string | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const scale = Math.min(1, maxPx / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor ?? null;
}

function newId(): string {
  return `q-${Math.random().toString(36).slice(2, 10)}`;
}

export function ScanClient({ forPour = false }: { forPour?: boolean } = {}) {
  const [cameraState, setCameraState] = useState<"starting" | "on" | "unavailable">("starting");
  const [cameraFacing, setCameraFacing] = useState<"environment" | "user">("environment");
  /**
   * Which engine drives the camera. Starts "pending" rather than probing during
   * render so the first client render matches the server's, then resolves to
   * "native" or "web" in the effect below.
   */
  const [scanEngine, setScanEngine] = useState<"pending" | "native" | "web">("pending");
  const [relationship, setRelationship] = useState<Relationship>("own");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const reviewTriggerRef = useRef<HTMLElement | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  /** Live on-device viewfinder guidance (frame analysis, no network). */
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  /** Highlight box over the detected barcode, in element coordinates. */
  const [lockBox, setLockBox] = useState<Box | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchChanging, setTorchChanging] = useState(false);
  const [torchUnavailable, setTorchUnavailable] = useState(false);
  const [torchReportedUnsupported, setTorchReportedUnsupported] = useState(false);
  /** Realtime label reading (web engine only — MLKit owns the native camera). */
  const [liveIdOn, setLiveIdOn] = useState(true);
  const [liveReading, setLiveReading] = useState(false);
  const [liveSuggest, setLiveSuggest] = useState<{
    guess: string | null;
    options: BottleSearchResult[];
  } | null>(null);
  // Both sheets below cover the whole screen; the page behind them holds still.
  useScrollLock(capture !== null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fileForItemRef = useRef<string | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  const lastDetectionAtRef = useRef<number | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const torchChangingRef = useRef(false);
  const torchSupportedRef = useRef(false);
  const torchOnRef = useRef(false);
  const autoTorchAttemptedRef = useRef(false);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live-ID pacing state, owned by the detector loop.
  const liveIdOnRef = useRef(true);
  const liveIdBusyRef = useRef(false);
  /** Set on 503/429 — AI is off or the budget is spent; stop trying this session. */
  const liveIdDisabledRef = useRef(false);
  const lastIdAtRef = useRef<number | null>(null);
  /** Luma plane of the frame last sent for ID, for the same-scene gate. */
  const lastIdLumasRef = useRef<Float32Array | null>(null);
  /**
   * Bumped when the scene has definitively moved on (a barcode was queued, or
   * the camera restarted) so an in-flight label read can't land suggestions
   * for the previous bottle under the current viewfinder.
   */
  const liveIdGenRef = useRef(0);
  /**
   * Identity of the current in-flight read. A camera restart bumps it while
   * clearing the busy flag, so a retired read's `finally` can't clear state
   * that now belongs to a newer read started by the restarted camera.
   */
  const liveIdReqRef = useRef(0);
  // Mirrors for the detector loop, which runs outside React's render cycle.
  const pausedRef = useRef(false);
  const relationshipRef = useRef(relationship);
  const itemsRef = useRef(items);
  const scanEngineRef = useRef(scanEngine);
  useEffect(() => {
    scanEngineRef.current = scanEngine;
  }, [scanEngine]);
  useEffect(() => {
    // Pause detection only while a modal owns the screen — background
    // resolution never blocks the next scan.
    pausedRef.current = capture !== null || reviewId !== null;
    relationshipRef.current = relationship;
    itemsRef.current = items;
    liveIdOnRef.current = liveIdOn;
  }, [capture, reviewId, relationship, items, liveIdOn]);

  const showToast = useCallback((text: string, kind: "ok" | "warn" = "ok") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  /** Record the confirmation (crowdsourcing the mapping) and shelve the bottle. */
  const confirmAdd = useCallback(
    async (itemId: string, upc: string | null, bottle: BottleSearchResult) => {
      patchItem(itemId, { status: "resolving" });
      try {
        const res = await fetch("/api/scan/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(upc ? { upc } : {}),
            bottleId: bottle.id,
            relationship: relationshipRef.current,
          }),
        });
        if (!res.ok) throw new Error(`confirm failed (${res.status})`);
        const data = (await res.json()) as { userBottle: { id: string } | null };
        const updated = res.status !== 201;
        patchItem(itemId, {
          status: "added",
          added: {
            userBottleId: data.userBottle?.id ?? null,
            bottleId: bottle.id,
            name: bottle.name,
            relationship: relationshipRef.current,
            updated,
          },
        });
        setReviewId((cur) => (cur === itemId ? null : cur));
        haptic("success");
        showToast(updated ? `${bottle.name} — shelf updated` : `Added ${bottle.name}`);
      } catch {
        patchItem(itemId, { status: "failed", subtitle: "Couldn't save — tap to retry." });
        haptic("warning");
        showToast("Couldn't save that one", "warn");
      }
    },
    [patchItem, showToast],
  );

  /** Background resolution for a barcode item. */
  const processUpcItem = useCallback(
    async (itemId: string, code: string) => {
      try {
        const res = await fetch("/api/scan/upc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ upc: code }),
        });
        if (!res.ok) throw new Error(`scan failed (${res.status})`);
        const data = (await res.json()) as ScanResponse;

        if (data.matches.length === 1) {
          await confirmAdd(itemId, data.upc, data.matches[0]);
          return;
        }
        if (data.matches.length > 1) {
          patchItem(itemId, {
            status: "review",
            title: "Which bottle is this?",
            subtitle: "This barcode is shared across bottlings — pick yours.",
            options: data.matches,
          });
          return;
        }
        if (data.candidates.length > 0) {
          patchItem(itemId, {
            status: "review",
            title: "Is it one of these?",
            subtitle: data.externalName ? `Barcode lookup says “${data.externalName}”.` : null,
            options: data.candidates,
          });
          return;
        }
        patchItem(itemId, {
          status: "review",
          title: "New one on us 🥃",
          subtitle:
            "We don't know this barcode yet. Find the bottle or snap the label — your confirmation teaches Whaikey for everyone.",
          options: [],
        });
      } catch {
        patchItem(itemId, { status: "failed", subtitle: "Network hiccup — tap to retry." });
      }
    },
    [confirmAdd, patchItem],
  );

  /** Background resolution for a label-photo item. */
  const processLabelItem = useCallback(
    async (itemId: string, dataUrl: string, mediaType: string) => {
      try {
        const base64 = dataUrl.split(",", 2)[1] ?? "";
        const res = await fetch("/api/scan-label", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageBase64: base64, mediaType }),
        });
        if (res.status === 503) {
          patchItem(itemId, {
            status: "review",
            title: "Find your bottle",
            subtitle: "AI label reading isn't configured — search the catalog instead.",
            options: [],
          });
          return;
        }
        if (!res.ok) throw new Error(`label scan failed (${res.status})`);
        const data = (await res.json()) as {
          extracted: { brandGuess: string | null; expressionGuess: string | null };
          candidates: BottleSearchResult[];
        };
        const guess = [data.extracted.brandGuess, data.extracted.expressionGuess]
          .filter(Boolean)
          .join(" ");
        patchItem(itemId, {
          status: "review",
          title: data.candidates.length > 0 ? "Is it one of these?" : "New one on us 🥃",
          subtitle: guess ? `The label reads “${guess}”.` : "Couldn't read much off that label.",
          options: data.candidates,
        });
      } catch {
        patchItem(itemId, { status: "failed", subtitle: "Couldn't read that photo — tap to retry." });
      }
    },
    [patchItem],
  );

  /** Enqueue a scanned/typed barcode. Returns false when the code is invalid. */
  const enqueueCode = useCallback(
    (raw: string): boolean => {
      const code = normalizeUpc(raw);
      if (!code || !isValidUpc(code)) {
        setManualError("That doesn't look like a UPC/EAN barcode.");
        return false;
      }
      setManualError(null);
      if (itemsRef.current.some((it) => it.upc === code && it.status !== "failed")) {
        haptic("warning");
        showToast("Already scanned this session", "warn");
        return true;
      }
      const item: QueueItem = {
        id: newId(),
        kind: "upc",
        upc: code,
        thumb: null,
        status: "resolving",
        title: "",
        subtitle: null,
        options: [],
        added: null,
      };
      setItems((prev) => [item, ...prev]);
      // A barcode hit supersedes whatever the label reader was working on —
      // retire in-flight reads and any suggestions still on screen.
      liveIdGenRef.current += 1;
      setLiveSuggest(null);
      haptic("lock");
      void processUpcItem(item.id, code);
      return true;
    },
    [processUpcItem, showToast],
  );

  /**
   * Repeat-window gate shared by both engines. MLKit reports every barcode in
   * view many times a second, so without this the queue fills with duplicates of
   * whatever bottle is being held up. Returns false when the code was swallowed.
   */
  const acceptCode = useCallback(
    (raw: string): boolean => {
      const code = normalizeUpc(raw);
      if (code) {
        const now = Date.now();
        const last = lastCodeRef.current;
        if (last && last.code === code && now - last.at < REPEAT_MS) return false;
        lastCodeRef.current = { code, at: now };
      }
      return enqueueCode(raw);
    },
    [enqueueCode],
  );

  /** Enqueue a confirmed label capture (or re-resolve an existing item with it). */
  const enqueueLabel = useCallback(
    (dataUrl: string, mediaType: string, forItemId: string | null) => {
      if (forItemId) {
        patchItem(forItemId, { kind: "label", thumb: dataUrl, status: "resolving" });
        setReviewId((cur) => (cur === forItemId ? null : cur));
        void processLabelItem(forItemId, dataUrl, mediaType);
        return;
      }
      const item: QueueItem = {
        id: newId(),
        kind: "label",
        upc: null,
        thumb: dataUrl,
        status: "resolving",
        title: "",
        subtitle: null,
        options: [],
        added: null,
      };
      setItems((prev) => [item, ...prev]);
      void processLabelItem(item.id, dataUrl, mediaType);
    },
    [patchItem, processLabelItem],
  );

  /** Sample a tiny downscaled frame: brightness/sharpness stats + luma plane. */
  const sampleFrame = useCallback(
    (video: HTMLVideoElement): { stats: FrameStats; lumas: Float32Array } | null => {
      try {
        if (!sampleCanvasRef.current) {
          sampleCanvasRef.current = document.createElement("canvas");
          sampleCanvasRef.current.width = 64;
          sampleCanvasRef.current.height = 48;
        }
        const canvas = sampleCanvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return {
          stats: frameStats(img.data, canvas.width, canvas.height),
          lumas: frameLumas(img.data, canvas.width, canvas.height),
        };
      } catch {
        return null;
      }
    },
    [],
  );

  /**
   * Realtime label ID: when the barcode loop is coming up dry on a good frame,
   * read the label instead — no shutter press needed. One read in flight at a
   * time, paced and scene-gated by `shouldAutoId`, and switched off for the
   * session the moment the server says AI is unconfigured or the budget is
   * spent (an AI failure must never block the manual core loop).
   */
  const maybeAutoId = useCallback(
    (
      video: HTMLVideoElement,
      sample: { stats: FrameStats; lumas: Float32Array } | null,
      msSinceDetection: number,
    ) => {
      if (!liveIdOnRef.current || liveIdDisabledRef.current) return;
      if (liveIdBusyRef.current) {
        // The scene drifted away from the frame a read is in flight for —
        // its result would describe a bottle no longer in view, so retire it
        // rather than let it surface under the wrong viewfinder.
        if (
          sample &&
          lastIdLumasRef.current &&
          lumaDelta(sample.lumas, lastIdLumasRef.current) >= SCENE_CHANGE_MIN
        ) {
          liveIdGenRef.current += 1;
        }
        return;
      }
      if (!sample) return;
      const now = Date.now();
      const wanted = shouldAutoId({
        msSinceDetection,
        msSinceLastId: lastIdAtRef.current === null ? Infinity : now - lastIdAtRef.current,
        stats: sample.stats,
        sceneDelta: lastIdLumasRef.current ? lumaDelta(sample.lumas, lastIdLumasRef.current) : null,
      });
      if (!wanted) return;
      const dataUrl = frameDataUrl(video, LIVE_ID_MAX_PX);
      if (!dataUrl) return;
      liveIdBusyRef.current = true;
      lastIdAtRef.current = now;
      lastIdLumasRef.current = sample.lumas;
      setLiveReading(true);
      const gen = liveIdGenRef.current;
      const req = ++liveIdReqRef.current;
      void (async () => {
        try {
          const res = await fetch("/api/scan-label", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              imageBase64: dataUrl.split(",", 2)[1] ?? "",
              mediaType: "image/jpeg",
            }),
          });
          if (res.status === 503 || res.status === 429) {
            liveIdDisabledRef.current = true;
            setLiveIdOn(false);
            showToast(
              res.status === 429
                ? "AI budget used for now — live label ID paused"
                : "AI label reading isn't configured — live ID off",
              "warn",
            );
            return;
          }
          if (!res.ok) return; // transient — the pacing gate retries later
          const data = (await res.json()) as {
            extracted: { brandGuess: string | null; expressionGuess: string | null };
            candidates: BottleSearchResult[];
          };
          // The user scanned or moved on while this read was in flight — a
          // suggestion for the previous bottle must never reach the screen.
          if (gen !== liveIdGenRef.current) return;
          const guess = [data.extracted.brandGuess, data.extracted.expressionGuess]
            .filter(Boolean)
            .join(" ");
          if (guess || data.candidates.length > 0) {
            setLiveSuggest({ guess: guess || null, options: data.candidates });
            haptic("lock");
          }
        } catch {
          // Offline blip — the loop tries again once the pacing gate reopens.
        } finally {
          // Only the read that owns the busy flag may clear it — a read
          // retired by a camera restart must not release a newer one's lock.
          if (req === liveIdReqRef.current) {
            liveIdBusyRef.current = false;
            setLiveReading(false);
          }
        }
      })();
    },
    [showToast],
  );

  /** One tap from the live strip: shelve the bottle, no sheets in between. */
  const addSuggestion = useCallback(
    (bottle: BottleSearchResult) => {
      const item: QueueItem = {
        id: newId(),
        kind: "label",
        upc: null,
        thumb: null,
        status: "resolving",
        title: "",
        subtitle: null,
        options: [],
        added: null,
      };
      setItems((prev) => [item, ...prev]);
      setLiveSuggest(null);
      void confirmAdd(item.id, null, bottle);
    },
    [confirmAdd],
  );

  /**
   * Toggle the rear camera's hardware torch. Under MLKit the camera belongs to
   * the plugin, so the torch is driven through it; on the web it's a constraint
   * on the `getUserMedia` track.
   */
  const toggleTorch = useCallback(async () => {
    if (torchChangingRef.current) return;

    if (scanEngineRef.current === "native") {
      const next = !torchOnRef.current;
      torchChangingRef.current = true;
      setTorchChanging(true);
      try {
        const reached = await setNativeTorch(next);
        torchOnRef.current = reached;
        setTorchOn(reached);
        if (next && !reached) setTorchUnavailable(true);
      } finally {
        torchChangingRef.current = false;
        setTorchChanging(false);
      }
      return;
    }

    const track = streamRef.current?.getVideoTracks()[0] as CameraTrack | undefined;
    if (!track?.applyConstraints) return;
    const next = !torchOnRef.current;
    torchChangingRef.current = true;
    setTorchChanging(true);
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      torchOnRef.current = next;
      setTorchOn(next);
    } catch {
      // Torch support can be withdrawn by the device; keep scanning uninterrupted.
      torchSupportedRef.current = false;
      torchOnRef.current = false;
      setTorchOn(false);
      setTorchUnavailable(true);
    } finally {
      torchChangingRef.current = false;
      setTorchChanging(false);
    }
  }, []);

  /**
   * Tap-to-refocus for the web engine: kick off a single-shot AF sweep where
   * the camera supports it (then hand control back to continuous), otherwise
   * re-assert continuous AF — either jolts a lens that's hunting or stuck.
   */
  const refocus = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0] as CameraTrack | undefined;
    if (!track?.applyConstraints) return;
    setGuidance({ kind: "hint", message: "Refocusing…" });
    try {
      const modes = track.getCapabilities?.().focusMode ?? [];
      if (modes.includes("single-shot")) {
        await track.applyConstraints({
          advanced: [{ focusMode: "single-shot" } as MediaTrackConstraintSet],
        });
        setTimeout(() => {
          track
            .applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] })
            .catch(() => {});
        }, 1200);
      } else if (modes.includes("continuous")) {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
        });
      }
    } catch {
      // The camera refused; the guidance line keeps coaching instead.
    }
  }, []);

  /** Flash the detected barcode's outline over the viewfinder for a beat. */
  const flashLockBox = useCallback((raw: Box, video: HTMLVideoElement) => {
    setLockBox(
      scaleBoxToCover(raw, video.videoWidth, video.videoHeight, video.clientWidth, video.clientHeight),
    );
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => setLockBox(null), 900);
  }, []);

  /**
   * Native engine: MLKit owns the camera and renders it behind the WebView, so
   * there is no `<video>` and no detection loop — barcodes arrive as events.
   * Falling through to `setScanEngine("web")` covers the web, a device that
   * can't scan natively, and a denied camera permission.
   */
  useEffect(() => {
    let cancelled = false;
    let session: NativeScanSession | null = null;

    (async () => {
      if (!isNativeApp()) {
        // Resolved here rather than in the effect body so the web path doesn't
        // set state synchronously during the effect (react-hooks/set-state-in-effect).
        if (!cancelled) setScanEngine("web");
        return;
      }
      const started = await startNativeScan({
        facing: cameraFacing === "environment" ? "back" : "front",
        onBarcode: (raw) => {
          // A modal owns the screen — the plugin keeps streaming regardless.
          if (pausedRef.current) return;
          if (acceptCode(raw)) setGuidance({ kind: "ok", message: "Got it" });
        },
      });
      if (cancelled) {
        await started?.stop();
        return;
      }
      if (!started) {
        setScanEngine("web");
        return;
      }
      session = started;
      setScanEngine("native");
      setCameraState("on");
      setGuidance(null);
      const torch = await isNativeTorchAvailable();
      torchSupportedRef.current = torch;
      setTorchReportedUnsupported(!torch);
    })();

    return () => {
      cancelled = true;
      void session?.stop();
      torchOnRef.current = false;
      setTorchOn(false);
    };
  }, [cameraFacing, acceptCode]);

  // Web engine: getUserMedia + BarcodeDetector loop with live on-device guidance.
  useEffect(() => {
    if (scanEngine !== "web") return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let tick = 0;

    (async () => {
      const Detector = barcodeDetectorCtor();
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState("unavailable");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Ask for a real resolution: the browser default (often 640×480)
          // starves the detector of pixels at bottle distance.
          video: {
            facingMode: { ideal: cameraFacing },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setTorchUnavailable(false);
        setTorchReportedUnsupported(false);
        const track = stream.getVideoTracks()[0] as CameraTrack | undefined;

        // Chrome on Android reports an empty capability set until the track
        // has fully started — probing only once at startup is why the torch
        // looked unsupported. Re-probe as the track settles and only trust an
        // explicit yes/no; if torch never surfaces, the button stays live and
        // an actual attempt decides (toggleTorch degrades gracefully).
        void (async () => {
          for (const wait of [0, 400, 1500]) {
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            if (cancelled || streamRef.current !== stream) return;
            try {
              const torch = track?.getCapabilities?.().torch;
              if (torch === true) {
                torchSupportedRef.current = true;
                setTorchReportedUnsupported(false);
                return;
              }
              if (torch === false) {
                torchSupportedRef.current = false;
                setTorchReportedUnsupported(true);
                return;
              }
            } catch {
              return;
            }
          }
        })();

        // Barcode decoding lives and dies by focus — ask for continuous AF
        // when the browser exposes it instead of whatever the camera picked.
        try {
          if (track?.getCapabilities?.().focusMode?.includes("continuous")) {
            await track.applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            });
          }
        } catch {
          // Focus stays camera-chosen; scanning still works.
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setCameraState("on");
        lastDetectionAtRef.current = Date.now(); // don't nag "move closer" instantly

        // Without `BarcodeDetector` (Safari, Firefox) the loop still runs —
        // guidance and the live label reader are what identify bottles there;
        // only barcode decoding is skipped.
        const detector = Detector ? new Detector({ formats: BARCODE_FORMATS }) : null;
        interval = setInterval(async () => {
          if (pausedRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
          const v = videoRef.current;
          tick++;
          try {
            const codes = detector ? await detector.detect(v) : [];
            /** A code was seen but none decoded to a GTIN — keep its hint. */
            let invalidCodeGuidance: Guidance | null = null;
            if (codes.length > 0 && codes[0]?.rawValue) {
              // A label can carry several codes (serials, case codes) — take
              // the one that decodes to a real GTIN, not just the first hit.
              const decoded = codes
                .map((c) => ({ c, code: normalizeUpc(c.rawValue ?? "") }))
                .find((d): d is { c: DetectedBarcode; code: string } =>
                  Boolean(d.code && isValidUpc(d.code)),
                );
              const hit = decoded?.c ?? codes[0];
              if (hit.boundingBox) flashLockBox(hit.boundingBox, v);
              if (decoded) {
                lastDetectionAtRef.current = Date.now();
                if (!acceptCode(decoded.code)) return;
                setGuidance({ kind: "ok", message: `Got it · ${decoded.code}` });
                return;
              }
              // Deliberately NOT counted as a detection, and NOT a dead end:
              // fall through so the live label reader gets its turn on
              // exactly these bottles (QR-only labels, serial Code 128s).
              invalidCodeGuidance =
                hit.format && !RETAIL_FORMATS.has(hit.format)
                  ? {
                      kind: "hint",
                      message: "That's a different code — find the retail barcode",
                    }
                  : {
                      kind: "warn",
                      message: "Found a barcode but couldn't read it — hold steady",
                    };
              setGuidance(invalidCodeGuidance);
            }
            // No usable barcode this frame: every other tick, analyze the
            // frame locally, coach the user (light → steadiness → distance),
            // and give the live label reader its chance.
            if (tick % 2 === 0) {
              const sample = sampleFrame(v);
              const stats = sample?.stats ?? null;
              const since =
                lastDetectionAtRef.current === null
                  ? Infinity
                  : Date.now() - lastDetectionAtRef.current;
              if (stats && stats.brightness < BRIGHTNESS_MIN) {
                if (
                  torchSupportedRef.current &&
                  !torchOnRef.current &&
                  !autoTorchAttemptedRef.current
                ) {
                  autoTorchAttemptedRef.current = true;
                  void toggleTorch();
                }
              } else {
                autoTorchAttemptedRef.current = false;
              }
              if (!invalidCodeGuidance) setGuidance(guidanceFor(stats, since, detector !== null));
              maybeAutoId(v, sample, since);
            }
          } catch {
            // Detection hiccups (tab hidden, etc.) — just try the next frame.
          }
        }, DETECT_INTERVAL_MS);
      } catch {
        if (!cancelled) setCameraState("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      torchChangingRef.current = false;
      torchSupportedRef.current = false;
      torchOnRef.current = false;
      autoTorchAttemptedRef.current = false;
      // Camera restart (facing switch, unmount) — retire in-flight reads:
      // their results are discarded (gen) and their completion no longer
      // clears the busy flag (req), which is released here instead.
      liveIdGenRef.current += 1;
      liveIdReqRef.current += 1;
      liveIdBusyRef.current = false;
      setLiveReading(false);
      setTorchOn(false);
      setTorchChanging(false);
    };
  }, [scanEngine, cameraFacing, acceptCode, flashLockBox, sampleFrame, maybeAutoId, toggleTorch]);

  /** Shutter: grab the current frame for on-device framing confirmation. */
  const captureFrame = useCallback(
    (forItemId: string | null) => {
      if (scanEngineRef.current === "native") {
        // MLKit owns the camera and exposes no still capture, so hand off to the
        // OS camera. Phase 2 replaces this with @capacitor/camera for a full-res
        // shot without leaving the scan session (docs/NATIVE_APP.md §3.1).
        fileForItemRef.current = forItemId;
        fileRef.current?.click();
        return;
      }
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const dataUrl = frameDataUrl(video, CAPTURE_MAX_PX);
      if (!dataUrl) return;
      // Same on-device analysis as the live guidance, applied to the shot.
      const warning = captureWarning(sampleFrame(video)?.stats ?? null);
      if (!warning) {
        // A deliberate, well-framed shutter press needs no second look —
        // straight into the queue; only a dark/blurry shot asks first.
        enqueueLabel(dataUrl, "image/jpeg", forItemId);
        showToast("Reading the label…");
        return;
      }
      setCapture({ dataUrl, mediaType: "image/jpeg", forItemId, warning });
    },
    [enqueueLabel, sampleFrame, showToast],
  );

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    if (enqueueCode(manualCode)) setManualCode("");
  };

  const onLabelFile = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => null);
    if (!dataUrl) {
      showToast("Couldn't read that photo", "warn");
      return;
    }
    const mediaType = /data:([^;]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
    // Same on-device confirmation step as a shutter capture.
    setCapture({ dataUrl, mediaType, forItemId: fileForItemRef.current, warning: null });
    fileForItemRef.current = null;
  };

  const undo = async (item: QueueItem) => {
    const added = item.added;
    setItems((prev) => prev.filter((it) => it.id !== item.id));
    if (added?.userBottleId && !added.updated) {
      await fetch(`/api/user-bottles/${added.userBottleId}`, { method: "DELETE" }).catch(() => {});
      showToast(`Removed ${added.name}`);
    } else if (added) {
      showToast(`${added.name} kept its earlier shelf entry`, "warn");
    }
  };

  const retry = (item: QueueItem) => {
    if (item.kind === "upc" && item.upc) {
      patchItem(item.id, { status: "resolving" });
      void processUpcItem(item.id, item.upc);
    } else if (item.kind === "label" && item.thumb) {
      // `thumb` is the original data URL, so recover its true media type
      // instead of assuming JPEG — a PNG mislabeled as JPEG is rejected upstream.
      const mediaType = /data:([^;]+)/.exec(item.thumb)?.[1] ?? "image/jpeg";
      patchItem(item.id, { status: "resolving" });
      void processLabelItem(item.id, item.thumb, mediaType);
    }
  };

  const addedCount = items.filter((it) => it.status === "added").length;
  const reviewCount = items.filter((it) => it.status === "review").length;
  const resolvingCount = items.filter((it) => it.status === "resolving").length;
  const reviewItem = reviewId ? items.find((item) => item.id === reviewId) ?? null : null;
  const closeReview = () => {
    setReviewId(null);
    requestAnimationFrame(() => reviewTriggerRef.current?.focus());
  };
  const manualVisible = cameraState !== "on" || manualOpen;

  return (
    <div className="px-4 pt-6 flex flex-col gap-5 pb-6">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">
          {forPour ? "Scan what you're pouring" : "Scan your shelf"}
        </h1>
        <p className="text-muted text-sm mt-1">
          {forPour
            ? "Point at the barcode or label, then log the pour."
            : "Keep scanning — bottles identify themselves in the background."}
        </p>
      </header>

      <div role="radiogroup" aria-label="Add scanned bottles as" className="flex gap-2">
        {RELATIONSHIPS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={relationship === r}
            onClick={() => setRelationship(r)}
            className={`chip min-h-11 px-4 text-sm font-medium ${
              relationship === r ? "chip-active" : "hover:text-foreground"
            }`}
          >
            {RELATIONSHIP_LABELS[r]}
          </button>
        ))}
      </div>

      {/* Viewfinder */}
      {cameraState !== "unavailable" && (
        <div className={`card relative overflow-hidden ${scanEngine === "native" ? "card-viewfinder" : ""}`}>
          {scanEngine === "native" ? (
            // MLKit renders the camera behind the WebView, so this reserves the
            // viewfinder's space and lets it show through (.card-viewfinder).
            <div className="w-full aspect-[4/3]" />
          ) : (
            <video ref={videoRef} playsInline muted className="w-full aspect-[4/3] object-cover" />
          )}
          {scanEngine === "web" && cameraState === "on" && (
            <button
              type="button"
              onClick={() => void refocus()}
              aria-label="Tap to refocus"
              title="Tap to refocus"
              className="absolute inset-0 w-full cursor-default bg-transparent"
            />
          )}
          <div aria-hidden className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-3/4 h-1/3 rounded-2xl border-2 border-accent/70 shadow-[0_0_24px_rgba(232,161,60,0.25)]" />
          </div>
          {liveReading && (
            <div
              role="status"
              className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs text-foreground/90"
            >
              <Loader2 size={14} strokeWidth={1.8} aria-hidden className="animate-spin" />
              Reading label…
            </div>
          )}
          {/* Live lock: outlines the barcode the detector just saw, in place. */}
          {lockBox && (
            <div
              aria-hidden
              className="absolute rounded-lg border-2 border-success shadow-[0_0_16px_rgba(94,178,122,0.5)] pointer-events-none transition-all duration-150"
              style={{
                left: `${lockBox.x}px`,
                top: `${lockBox.y}px`,
                width: `${lockBox.width}px`,
                height: `${lockBox.height}px`,
              }}
            />
          )}
          <div className="absolute bottom-0 inset-x-0 p-3 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent">
            <span
              role="status"
              aria-live="polite"
              className={`text-sm flex items-center gap-2 min-w-0 ${
                guidance?.kind === "ok"
                  ? "text-success"
                  : guidance?.kind === "warn"
                    ? "text-accent"
                    : "text-foreground/90"
              }`}
            >
              {guidance?.kind === "ok" ? (
                <Check size={18} strokeWidth={2} aria-hidden className="shrink-0" />
              ) : (
                <ScanLine size={18} strokeWidth={1.8} aria-hidden className="text-accent shrink-0" />
              )}
              <span className="truncate">
                {cameraState !== "on"
                  ? "Starting camera…"
                  : (guidance?.message ?? "Center the barcode, or shutter for the label")}
              </span>
            </span>
            {/* Icon-only round controls: five of these plus the guidance text
                must fit a 375px viewport without clipping (the card is
                overflow-hidden, so anything wider simply disappears). */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setCameraFacing((facing) => facing === "environment" ? "user" : "environment")}
                disabled={cameraState !== "on"}
                aria-label={cameraFacing === "environment" ? "Switch to front camera" : "Use rear camera"}
                title={cameraFacing === "environment" ? "Switch to front camera" : "Use rear camera"}
                className="btn-secondary min-w-11 min-h-11 flex items-center justify-center rounded-full disabled:opacity-50"
              >
                <SwitchCamera size={18} strokeWidth={1.8} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setManualOpen((v) => !v)}
                aria-pressed={manualOpen}
                aria-label="Type in the barcode"
                title="Type in the barcode"
                className={`btn-secondary min-w-11 min-h-11 flex items-center justify-center rounded-full ${manualOpen ? "text-accent" : ""}`}
              >
                <Keyboard size={18} strokeWidth={1.8} aria-hidden />
              </button>
              {scanEngine === "web" && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !liveIdOn;
                    setLiveIdOn(next);
                    if (!next) {
                      // Off must mean off: retire any in-flight read and
                      // drop whatever it already put on screen.
                      liveIdGenRef.current += 1;
                      setLiveSuggest(null);
                      setLiveReading(false);
                    }
                  }}
                  disabled={cameraState !== "on"}
                  aria-pressed={liveIdOn}
                  aria-label={liveIdOn ? "Turn off live label ID" : "Turn on live label ID"}
                  title={
                    liveIdOn
                      ? "Live label ID on — labels are read automatically"
                      : "Live label ID off"
                  }
                  className={`btn-secondary min-w-11 min-h-11 flex items-center justify-center rounded-full disabled:opacity-50 ${
                    liveIdOn ? "text-accent" : ""
                  }`}
                >
                  <Sparkles size={18} strokeWidth={1.8} aria-hidden />
                </button>
              )}
              <button
                type="button"
                onClick={() => void toggleTorch()}
                aria-label={
                  torchUnavailable || torchReportedUnsupported
                    ? "Flashlight unavailable"
                    : torchOn
                      ? "Turn flashlight off"
                      : "Turn flashlight on"
                }
                aria-pressed={torchOn}
                title={
                  torchUnavailable || torchReportedUnsupported
                    ? "Flashlight unavailable on this camera"
                    : torchOn
                      ? "Turn flashlight off"
                      : "Turn flashlight on"
                }
                disabled={cameraState !== "on" || torchChanging || torchUnavailable || torchReportedUnsupported}
                className={`btn-secondary min-w-11 min-h-11 flex items-center justify-center rounded-full disabled:opacity-50 ${torchOn ? "text-accent" : ""}`}
              >
                {torchOn ? (
                  <FlashlightOff size={18} strokeWidth={1.8} aria-hidden />
                ) : (
                  <Flashlight size={18} strokeWidth={1.8} aria-hidden />
                )}
              </button>
              <button
                type="button"
                onClick={() => captureFrame(null)}
                disabled={cameraState !== "on"}
                aria-label="Capture the label"
                className="btn-primary min-w-11 min-h-11 flex items-center justify-center rounded-full disabled:opacity-50"
              >
                <Aperture size={20} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Realtime label suggestions — one tap to shelve, no sheet. */}
      {liveSuggest && (
        <section aria-label="Live label match" className="card-flat p-3.5 flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-muted leading-relaxed min-w-0">
              <Sparkles size={14} strokeWidth={1.8} aria-hidden className="inline mr-1.5 text-accent" />
              {liveSuggest.guess ? (
                <>
                  Label reads{" "}
                  <span className="text-foreground font-medium">&ldquo;{liveSuggest.guess}&rdquo;</span>
                </>
              ) : (
                "Read the label"
              )}
              {liveSuggest.options.length === 0 &&
                " — no catalog match yet. Keep the barcode in frame or search below."}
            </p>
            <button
              type="button"
              onClick={() => setLiveSuggest(null)}
              aria-label="Dismiss label suggestions"
              className="btn-secondary rounded-full shrink-0 min-w-11 min-h-11 flex items-center justify-center"
            >
              <X size={16} strokeWidth={2} aria-hidden />
            </button>
          </div>
          {liveSuggest.options.length > 0 && (
            <ul className="flex flex-col gap-2">
              {liveSuggest.options.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{b.name}</div>
                    <div className="text-xs text-muted truncate mt-0.5">
                      {[b.distillery, originLabel(b.region, b.country)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => addSuggestion(b)}
                    className="btn-primary shrink-0 min-h-11 px-4 text-sm font-medium flex items-center"
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {cameraState === "unavailable" && (
        <div className="card p-5 flex flex-col gap-2">
          <p className="font-medium flex items-center gap-2">
            <Camera size={18} strokeWidth={1.8} aria-hidden className="text-muted" />
            Camera scanning isn&apos;t available here
          </p>
          <p className="text-sm text-muted leading-relaxed">
            Type or wedge-scan the barcode number below — or snap a photo of the label and let
            Whaikey read it.
          </p>
        </div>
      )}

      {/* Manual entry + label photo */}
      {manualVisible && (
        <form onSubmit={onManualSubmit} className="flex flex-col gap-2">
          <label htmlFor="scan-code" className="section-label">
            Barcode number
          </label>
          <div className="flex gap-2">
            <input
              id="scan-code"
              autoFocus={cameraState === "unavailable"}
              inputMode="numeric"
              autoComplete="off"
              value={manualCode}
              onChange={(e) => {
                setManualCode(e.target.value);
                setManualError(null);
              }}
              placeholder="e.g. 080244002145"
              className="flex-1 min-w-0 rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
            />
            <button
              type="submit"
              disabled={manualCode.trim().length === 0}
              className="btn-primary px-5 py-3 text-sm font-medium disabled:opacity-50"
            >
              Scan
            </button>
          </div>
          {manualError && (
            <p role="alert" className="text-sm text-danger">
              {manualError}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              fileForItemRef.current = null;
              fileRef.current?.click();
            }}
            className="btn-secondary mt-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2"
          >
            <ImageUp size={18} strokeWidth={1.8} aria-hidden />
            Snap the label instead
          </button>
        </form>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label="Photograph a bottle label"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onLabelFile(file);
        }}
      />

      {toast && (
        <p
          role="status"
          className={`card-flat px-4 py-3 text-sm ${
            toast.kind === "ok" ? "text-foreground" : "text-muted"
          }`}
        >
          {toast.kind === "ok" ? "✓ " : ""}
          {toast.text}
        </p>
      )}

      {/* Session queue */}
      <section aria-label="Scanned this session">
        <div className="flex items-baseline justify-between mb-3 gap-3">
          <h2 className="section-label">
            Scanned this session ({addedCount}
            {resolvingCount > 0 ? ` · ${resolvingCount} identifying` : ""}
            {reviewCount > 0 ? ` · ${reviewCount} need you` : ""})
          </h2>
          {addedCount > 0 && reviewCount === 0 && resolvingCount === 0 && (
            <Link href="/bar" className="text-sm text-accent font-medium shrink-0">
              Done → My Bar
            </Link>
          )}
        </div>
        {items.length === 0 ? (
          <div className="card p-8 text-center flex flex-col items-center gap-2">
            <div aria-hidden className="text-4xl mb-1">🥃</div>
            <p className="font-display text-lg font-semibold">Line up the bottles</p>
            <p className="text-sm text-muted leading-relaxed max-w-xs">
              Scan one after another — no waiting between bottles. Anything ambiguous queues up
              for you to settle at the end.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id} className="card-flat flex items-center justify-between gap-3 p-3.5">
                <div className="min-w-0 flex items-center gap-2.5">
                  {item.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
                    <img
                      src={item.thumb}
                      alt=""
                      className="w-9 h-9 rounded-lg object-cover shrink-0 border border-border-subtle"
                    />
                  ) : item.status === "added" ? (
                    <Check size={18} strokeWidth={2} aria-hidden className="text-success shrink-0" />
                  ) : (
                    <ScanLine size={18} strokeWidth={1.8} aria-hidden className="text-muted shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {item.added?.name ??
                        (item.kind === "label" ? "Label photo" : (item.upc ?? "Barcode"))}
                    </div>
                    <div className="text-xs text-muted mt-0.5 truncate">
                      {item.status === "resolving" && "Identifying…"}
                      {item.status === "added" &&
                        `${item.added?.updated ? "shelf updated" : RELATIONSHIP_LABELS[item.added!.relationship]}${
                          item.upc ? ` · ${item.upc}` : ""
                        }`}
                      {item.status === "review" && (item.subtitle ?? item.title)}
                      {item.status === "failed" && (item.subtitle ?? "Failed")}
                    </div>
                  </div>
                </div>
                <div className="shrink-0">
                  {item.status === "resolving" && (
                    <Loader2 size={18} strokeWidth={1.8} aria-hidden className="animate-spin text-muted" />
                  )}
                  {item.status === "added" && (
                    <div className="flex items-center gap-2">
                      {item.added && (
                        <Link
                          href={`/pour?bottleId=${encodeURIComponent(item.added.bottleId)}`}
                          className={`px-3 py-2 text-xs font-medium flex items-center gap-1.5 ${
                            forPour ? "btn-primary" : "btn-secondary"
                          }`}
                        >
                          <GlassWater size={14} strokeWidth={1.8} aria-hidden /> Pour
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => void undo(item)}
                        className="btn-secondary px-3 py-2 text-xs font-medium flex items-center gap-1.5"
                      >
                        <Undo2 size={14} strokeWidth={1.8} aria-hidden /> Undo
                      </button>
                    </div>
                  )}
                  {item.status === "review" && (
                    <button
                      type="button"
                      onClick={(event) => {
                        reviewTriggerRef.current = event.currentTarget;
                        setReviewId(item.id);
                      }}
                      className="btn-primary px-3.5 py-2 text-xs font-medium"
                    >
                      Needs you
                    </button>
                  )}
                  {item.status === "failed" && (
                    <button
                      type="button"
                      onClick={() => retry(item)}
                      className="btn-secondary px-3 py-2 text-xs font-medium flex items-center gap-1.5"
                    >
                      <RefreshCw size={14} strokeWidth={1.8} aria-hidden /> Retry
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-center text-sm text-muted">
        Have a spreadsheet or an export from another app?{" "}
        <Link href="/import" className="text-accent font-medium">
          Import it
        </Link>
      </p>

      {/* On-device framing confirmation before anything is uploaded */}
      {capture && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm label photo"
        >
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setCapture(null)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative card rounded-b-none p-5 flex flex-col gap-4">
            <div>
              <h2 className="font-display text-xl font-semibold">Use this photo?</h2>
              <p className="text-sm text-muted mt-1">
                Make sure the label fills the frame and the name is readable.
              </p>
              {capture.warning && (
                <p className="text-sm text-accent mt-2 font-medium">{capture.warning}</p>
              )}
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
            <img
              src={capture.dataUrl}
              alt="Captured label preview"
              className="w-full max-h-[40dvh] object-contain rounded-xl border border-border-subtle bg-black/40"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const c = capture;
                  setCapture(null);
                  enqueueLabel(c.dataUrl, c.mediaType, c.forItemId);
                }}
                className="btn-primary flex-1 px-4 py-3 text-sm font-medium"
              >
                Use photo
              </button>
              <button
                type="button"
                onClick={() => {
                  const forItemId = capture.forItemId;
                  setCapture(null);
                  if (cameraState === "on") {
                    // brief pause so the user can re-frame, then they hit the shutter again
                  } else {
                    fileForItemRef.current = forItemId;
                    fileRef.current?.click();
                  }
                }}
                className="btn-secondary flex-1 px-4 py-3 text-sm font-medium"
              >
                Retake
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewItem && (
        <DecisionSheet
          item={reviewItem}
          onPick={(bottle) => {
            closeReview();
            void confirmAdd(reviewItem.id, reviewItem.upc, bottle);
          }}
          onLabelPhoto={() => {
            if (cameraState === "on") {
              setReviewId(null);
              captureFrame(reviewItem.id);
            } else {
              fileForItemRef.current = reviewItem.id;
              setReviewId(null);
              fileRef.current?.click();
            }
          }}
          onRemove={() => {
            setItems((prev) => prev.filter((it) => it.id !== reviewItem.id));
            setReviewId(null);
          }}
          onClose={closeReview}
        />
      )}
    </div>
  );
}

/**
 * Bottom sheet for confirm-or-correct moments: ambiguous barcodes, external
 * candidates, and full misses (with inline catalog search so the user can
 * teach Whaikey the right answer without leaving the flow).
 */
function DecisionSheet({
  item,
  onPick,
  onLabelPhoto,
  onRemove,
  onClose,
}: {
  item: QueueItem;
  onPick: (bottle: BottleSearchResult) => void;
  onLabelPhoto: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BottleSearchResult[]>([]);
  useScrollLock(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      try {
        const res = await fetch(`/api/bottles/search?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { results: BottleSearchResult[] };
        setResults(data.results.slice(0, 6));
      } catch {
        // aborted or offline — keep previous results
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const options = query.trim() ? results : item.options;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={item.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div ref={panelRef} className="relative card rounded-b-none p-5 max-h-[80dvh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold">{item.title}</h2>
            {item.subtitle && (
              <p className="text-sm text-muted mt-1 leading-relaxed">{item.subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-secondary p-2 rounded-full"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {options.length > 0 && (
          <ul className="flex flex-col gap-2">
            {options.map((b) => (
              <li key={b.id} className="card-flat flex items-center justify-between gap-3 p-3.5">
                <div className="min-w-0">
                  <div className="font-medium truncate">{b.name}</div>
                  <div className="text-xs text-muted truncate mt-0.5">
                    {[b.distillery, originLabel(b.region, b.country)].filter(Boolean).join(" · ")}
                  </div>
                  <div className="mt-1.5">
                    <CategoryChip category={b.category} />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPick(b)}
                  className="btn-primary shrink-0 px-4 py-2.5 text-sm font-medium"
                >
                  This one
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="scan-sheet-search" className="section-label">
            {item.options.length > 0 ? "None of these? Search" : "Search the catalog"}
          </label>
          <input
            ref={searchRef}
            id="scan-sheet-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Try "eagle 10" or "ECBP"'
            className="w-full rounded-xl border border-border-subtle bg-surface py-3 px-4 text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
          />
          <button
            type="button"
            onClick={onLabelPhoto}
            className="btn-secondary px-4 py-3 text-sm font-medium flex items-center justify-center gap-2"
          >
            <ImageUp size={18} strokeWidth={1.8} aria-hidden />
            Snap the label instead
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Skip this one
          </button>
        </div>
      </div>
    </div>
  );
}
