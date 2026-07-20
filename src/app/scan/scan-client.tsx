"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Aperture,
  Camera,
  Check,
  ImageUp,
  Keyboard,
  Loader2,
  RefreshCw,
  ScanLine,
  Undo2,
  X,
} from "lucide-react";
import { RELATIONSHIPS, type Relationship } from "@/db/schema";
import { isValidUpc, normalizeUpc } from "@/lib/upc";
import type { BottleSearchResult } from "@/lib/ai/tools";
import { CategoryChip } from "@/components/category-chip";
import {
  captureWarning,
  frameStats,
  guidanceFor,
  scaleBoxToCover,
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
 * continuously and a shutter button captures a framed label photo (confirmed
 * on-device before anything is uploaded) for AI identification.
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
  boundingBox?: Box;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

const BARCODE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];
/** Ignore re-detections of the same code within this window (ms). */
const REPEAT_MS = 4000;
const DETECT_INTERVAL_MS = 300;
/** Longest edge for uploaded label captures. */
const CAPTURE_MAX_PX = 1280;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor ?? null;
}

function newId(): string {
  return `q-${Math.random().toString(36).slice(2, 10)}`;
}

export function ScanClient() {
  const [cameraState, setCameraState] = useState<"starting" | "on" | "unavailable">("starting");
  const [relationship, setRelationship] = useState<Relationship>("own");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  /** Live on-device viewfinder guidance (frame analysis, no network). */
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  /** Highlight box over the detected barcode, in element coordinates. */
  const [lockBox, setLockBox] = useState<Box | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fileForItemRef = useRef<string | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  const lastDetectionAtRef = useRef<number | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors for the detector loop, which runs outside React's render cycle.
  const pausedRef = useRef(false);
  const relationshipRef = useRef(relationship);
  const itemsRef = useRef(items);
  useEffect(() => {
    // Pause detection only while a modal owns the screen — background
    // resolution never blocks the next scan.
    pausedRef.current = capture !== null || reviewId !== null;
    relationshipRef.current = relationship;
    itemsRef.current = items;
  }, [capture, reviewId, relationship, items]);

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
        navigator.vibrate?.(60);
        showToast(updated ? `${bottle.name} — shelf updated` : `Added ${bottle.name}`);
      } catch {
        patchItem(itemId, { status: "failed", subtitle: "Couldn't save — tap to retry." });
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
      navigator.vibrate?.(30);
      void processUpcItem(item.id, code);
      return true;
    },
    [processUpcItem, showToast],
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

  /** Sample a tiny downscaled frame for on-device brightness/sharpness stats. */
  const sampleFrameStats = useCallback((video: HTMLVideoElement): FrameStats | null => {
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
      return frameStats(img.data, canvas.width, canvas.height);
    } catch {
      return null;
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

  // Camera + barcode detection loop with live on-device guidance.
  useEffect(() => {
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
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setCameraState("on");
        lastDetectionAtRef.current = Date.now(); // don't nag "move closer" instantly

        if (!Detector) return; // camera preview + shutter still work; no barcode loop
        const detector = new Detector({ formats: BARCODE_FORMATS });
        interval = setInterval(async () => {
          if (pausedRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
          const v = videoRef.current;
          tick++;
          try {
            const codes = await detector.detect(v);
            const hit = codes[0];
            if (hit?.rawValue) {
              lastDetectionAtRef.current = Date.now();
              if (hit.boundingBox) flashLockBox(hit.boundingBox, v);

              const code = normalizeUpc(hit.rawValue);
              if (!code || !isValidUpc(code)) {
                setGuidance({
                  kind: "warn",
                  message: "Found a barcode but couldn't read it — hold steady",
                });
                return;
              }
              const now = Date.now();
              const last = lastCodeRef.current;
              if (last && last.code === code && now - last.at < REPEAT_MS) return;
              lastCodeRef.current = { code, at: now };
              setGuidance({ kind: "ok", message: `Got it · ${code}` });
              enqueueCode(code);
              return;
            }
            // No barcode this frame: every other tick, analyze the frame
            // locally and coach the user (light → steadiness → distance).
            if (tick % 2 === 0) {
              const stats = sampleFrameStats(v);
              const since =
                lastDetectionAtRef.current === null
                  ? Infinity
                  : Date.now() - lastDetectionAtRef.current;
              setGuidance(guidanceFor(stats, since));
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
    };
  }, [enqueueCode, flashLockBox, sampleFrameStats]);

  /** Shutter: grab the current frame for on-device framing confirmation. */
  const captureFrame = useCallback(
    (forItemId: string | null) => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const scale = Math.min(1, CAPTURE_MAX_PX / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      setCapture({
        dataUrl: canvas.toDataURL("image/jpeg", 0.85),
        mediaType: "image/jpeg",
        forItemId,
        // Same on-device analysis as the live guidance, applied to the shot.
        warning: captureWarning(sampleFrameStats(video)),
      });
    },
    [sampleFrameStats],
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
      patchItem(item.id, { status: "resolving" });
      void processLabelItem(item.id, item.thumb, "image/jpeg");
    }
  };

  const addedCount = items.filter((it) => it.status === "added").length;
  const reviewCount = items.filter((it) => it.status === "review").length;
  const resolvingCount = items.filter((it) => it.status === "resolving").length;
  const reviewItem = reviewId ? (items.find((it) => it.id === reviewId) ?? null) : null;
  const manualVisible = cameraState !== "on" || manualOpen;

  return (
    <div className="px-4 pt-6 flex flex-col gap-5 pb-6">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">Scan your shelf</h1>
        <p className="text-muted text-sm mt-1">
          Keep scanning — bottles identify themselves in the background.
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
        <div className="card relative overflow-hidden">
          <video ref={videoRef} playsInline muted className="w-full aspect-[4/3] object-cover" />
          <div aria-hidden className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-3/4 h-1/3 rounded-2xl border-2 border-accent/70 shadow-[0_0_24px_rgba(232,161,60,0.25)]" />
          </div>
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
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setManualOpen((v) => !v)}
                className="btn-secondary px-3 py-2 text-xs font-medium flex items-center gap-1.5"
              >
                <Keyboard size={16} strokeWidth={1.8} aria-hidden /> Type it
              </button>
              <button
                type="button"
                onClick={() => captureFrame(null)}
                disabled={cameraState !== "on"}
                aria-label="Capture the label"
                className="btn-primary p-2.5 rounded-full disabled:opacity-50"
              >
                <Aperture size={20} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          </div>
        </div>
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
                    <button
                      type="button"
                      onClick={() => void undo(item)}
                      className="btn-secondary px-3 py-2 text-xs font-medium flex items-center gap-1.5"
                    >
                      <Undo2 size={14} strokeWidth={1.8} aria-hidden /> Undo
                    </button>
                  )}
                  {item.status === "review" && (
                    <button
                      type="button"
                      onClick={() => setReviewId(item.id)}
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
          onPick={(bottle) => void confirmAdd(reviewItem.id, reviewItem.upc, bottle)}
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
          onClose={() => setReviewId(null)}
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
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative card rounded-b-none p-5 max-h-[80dvh] overflow-y-auto flex flex-col gap-4">
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
                    {[b.distillery, b.region].filter(Boolean).join(" · ")}
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
