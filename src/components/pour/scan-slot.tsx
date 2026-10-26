"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, CameraOff, Repeat, ScanLine, Search, X } from "lucide-react";
import { isNativeApp } from "@/lib/native/platform";
import { startNativeScan, type NativeScanSession } from "@/lib/native/barcode";
import { haptic } from "@/lib/native/haptics";
import { ToggleSwitch } from "@/components/toggle-switch";
import { identifyLabel } from "@/lib/label-scan";
import { bottleMeta, decideScan, productCode, type ScanBottle, type ScanDecision, type UpcLookup } from "./scan-decision";

/** D16: the camera pauses itself after ~2 minutes with nothing read. */
export const CAMERA_AUTO_PAUSE_MS = 120_000;
/**
 * Keep-scanning hard cap: however busy the tasting, the camera stops after
 * this long and needs one tap to resume — a phone left face-up on the bar
 * must not drain overnight because something kept reading barcodes.
 */
export const CAMERA_MAX_SESSION_MS = 15 * 60_000;
const DETECT_INTERVAL_MS = 300;
const BARCODE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8", "itf", "code_128"];

interface DetectedBarcode {
  rawValue: string;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<DetectedBarcode[]> };

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

type CameraState = "starting" | "on" | "paused" | "unavailable";

export interface PickMeta {
  /** How the bottle got into the slot — "barcode" earns the "Not it?" row. */
  via: "barcode" | "label" | "search" | "recent";
  alternatives?: ScanBottle[];
}

/** An unknown barcode and everything the sheet could read about it. */
interface UnknownBarcode {
  upc: string;
  /** What a product database calls it, when one knew the code but not the bottle. */
  externalName: string | null;
  /** What the label photo read, once one was snapped. */
  labelText: string | null;
}

interface TeachResponse {
  teach?: { state: string; confirmations: number; required: number; taught: boolean } | null;
}

/** The sentence a crowd-confirm outcome earns (same flow as the scanner, #100). */
export function teachMessage(bottleName: string, data: TeachResponse | null): string {
  const teach = data?.teach;
  if (teach?.taught) return `You taught Whaikey this barcode — ${bottleName}`;
  if (teach?.state === "pending") {
    const left = Math.max(0, (teach.required ?? 2) - (teach.confirmations ?? 1));
    return left > 0
      ? `Barcode saved for ${bottleName} — ${left} more confirmation${left === 1 ? "" : "s"} adds it for everyone`
      : `Barcode saved for ${bottleName} — waiting for review`;
  }
  return `Thanks — barcode noted for ${bottleName}`;
}

interface SearchResult {
  id: string;
  name: string;
  distillery?: string | { name?: string } | null;
  category?: string | null;
  region?: string | null;
  abv?: number | null;
  ageYears?: number | null;
}

function toBottle(r: SearchResult): ScanBottle {
  const distillery = typeof r.distillery === "string" ? r.distillery : (r.distillery?.name ?? null);
  return { id: r.id, name: r.name, distillery, category: r.category ?? null, region: r.region ?? null, abv: r.abv ?? null, ageYears: r.ageYears ?? null };
}

/**
 * The pour sheet's bottle slot (docs/STORYBOARD.md §2.2, D5/D16; design board
 * direction B): a compact live viewfinder — barcode first, a label snap when
 * the barcode can't be read — with a type-to-search field directly beneath it
 * and recent bottles as one-tap chips.
 *
 * The camera starts as soon as the sheet opens; that first ＋ is where the
 * permission prompt lands (decision S6), with a one-line why. Denied or absent
 * cameras degrade to typing, never to a dead end.
 */
export function PourScanSlot({
  onPick,
  missingNotice = false,
  compact = false,
  keepScanning,
  onKeepScanningChange,
  onNotice,
  round = 0,
}: {
  onPick: (bottle: ScanBottle, meta: PickMeta) => void;
  missingNotice?: boolean;
  /** A bottle is already in the sheet: show only the live viewfinder (keep-scanning). */
  compact?: boolean;
  /** Keep the camera running after a pick (fast multi-pour logging). Absent ⇒ no toggle. */
  keepScanning?: boolean;
  onKeepScanningChange?: (next: boolean) => void;
  /** Outcome lines the sheet should toast (e.g. what teaching a barcode did). */
  onNotice?: (message: string) => void;
  /** Bumped by the sheet after each saved pour so the same bottle can be read again. */
  round?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  const [camera, setCamera] = useState<CameraState>("starting");
  const [engine, setEngine] = useState<"web" | "native" | null>(null);
  const [canDetect, setCanDetect] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [choice, setChoice] = useState<Extract<ScanDecision, { kind: "choose" }> | null>(null);
  const [miss, setMiss] = useState<UnknownBarcode | null>(null);
  const [teach, setTeach] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const missRef = useRef<UnknownBarcode | null>(null);
  useEffect(() => {
    missRef.current = miss;
  }, [miss]);
  /** Pauses the running camera; set by the camera effect for the idle timer. */
  const pauseRef = useRef<(() => void) | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armIdle = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => pauseRef.current?.(), CAMERA_AUTO_PAUSE_MS);
  }, []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScanBottle[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [recent, setRecent] = useState<ScanBottle[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [labelVia, setLabelVia] = useState<"ocr" | "ai" | null>(null);

  // Recent bottles from the pour history — one tap re-logs a known bottle.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/pours?limit=20")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { pours?: Array<{ bottleId: string; bottleName: string }> } | null) => {
        if (cancelled || !data?.pours) return;
        const seen = new Set<string>();
        const unique: ScanBottle[] = [];
        for (const p of data.pours) {
          if (seen.has(p.bottleId)) continue;
          seen.add(p.bottleId);
          unique.push({ id: p.bottleId, name: p.bottleName });
          if (unique.length >= 4) break;
        }
        setRecent(unique);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The sheet passes a fresh `onPick` every render; reading it through a ref
  // keeps the camera effect from restarting on every keystroke in the sheet.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  const resolveBarcode = useCallback(
    async (raw: string) => {
      const code = productCode(raw);
      if (!code || seenRef.current.has(code) || busyRef.current) return;
      seenRef.current.add(code);
      busyRef.current = true;
      setStatus("Reading barcode…");
      try {
        const res = await fetch("/api/scan/upc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ upc: code }),
        });
        // A non-GTIN code (a QR, a shelf tag) is a 400: keep looking.
        if (res.status === 400) {
          setStatus(null);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const decision = decideScan((await res.json()) as UpcLookup);
        // Something was read: the idle clock starts over (keep-scanning).
        armIdle();
        if (decision.kind === "exact") {
          haptic("lock");
          setStatus(null);
          setMiss(null);
          onPickRef.current(decision.bottle, { via: "barcode", alternatives: decision.alternatives });
        } else if (decision.kind === "choose") {
          haptic("tap");
          setStatus(null);
          setMiss(null);
          setChoice(decision);
        } else {
          haptic("tap");
          setStatus(null);
          setChoice(null);
          setMiss({ upc: decision.upc, externalName: decision.externalName, labelText: null });
        }
      } catch {
        seenRef.current.delete(code);
        setStatus("Couldn't look that barcode up — type a name below.");
      } finally {
        busyRef.current = false;
      }
    },
    [armIdle],
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Camera engines: MLKit behind the WebView in the native shell, otherwise
  // getUserMedia + BarcodeDetector (Chromium) — the same split as /scan.
  useEffect(() => {
    if (attempt < 0) return;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let native: NativeScanSession | null = null;
    const pause = () => {
      if (cancelled) return;
      cancelled = true;
      if (interval) clearInterval(interval);
      void native?.stop();
      stopCamera();
      setCamera("paused");
    };
    pauseRef.current = pause;
    // Idle pause (re-armed by every read) and a hard cap that nothing extends.
    armIdle();
    const capTimer = setTimeout(pause, CAMERA_MAX_SESSION_MS);

    (async () => {
      if (isNativeApp()) {
        const session = await startNativeScan({ onBarcode: (raw) => void resolveBarcode(raw) });
        if (cancelled) {
          await session?.stop();
          return;
        }
        if (session) {
          native = session;
          setEngine("native");
          setCanDetect(true);
          setCamera("on");
          return;
        }
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera("unavailable");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
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
        await video.play().catch(() => {});
        if (cancelled) return;
        setEngine("web");
        setCamera("on");
        const Detector = barcodeDetectorCtor();
        setCanDetect(Boolean(Detector));
        if (!Detector) return;
        const detector = new Detector({ formats: BARCODE_FORMATS });
        interval = setInterval(async () => {
          if (cancelled || busyRef.current || video.readyState < 2) return;
          try {
            const codes = await detector.detect(video);
            // Any valid product code in the frame, not just the first payload:
            // a lot number beside the UPC must not shadow it.
            const hit = codes.find((c) => c.rawValue && productCode(c.rawValue));
            if (hit) void resolveBarcode(hit.rawValue);
          } catch {
            // A frame the detector couldn't read; the next one might.
          }
        }, DETECT_INTERVAL_MS);
      } catch {
        if (!cancelled) setCamera("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(capTimer);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (pauseRef.current === pause) pauseRef.current = null;
      if (interval) clearInterval(interval);
      void native?.stop();
      stopCamera();
    };
  }, [attempt, resolveBarcode, stopCamera, armIdle]);

  // A saved pour starts a new round: the bottle just logged may be read again.
  useEffect(() => {
    seenRef.current.clear();
    if (round > 0) armIdle();
  }, [round, armIdle]);

  /** Stop control: the camera goes off now, and keep-scanning with it. */
  function stopNow() {
    pauseRef.current?.();
    onKeepScanningChange?.(false);
  }

  /**
   * Every pick goes through here. While an unknown barcode is on the card and
   * "Teach this barcode" is on, the pick is also a crowd confirmation of that
   * barcode → bottle (the scanner's #100 flow, two agreeing people add it for
   * everyone). It never shelves anything.
   */
  function finish(b: ScanBottle, meta: PickMeta) {
    const unknown = missRef.current;
    if (unknown && teach) {
      void fetch("/api/scan/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upc: unknown.upc, bottleId: b.id }),
      })
        .then((res) => (res.ok ? (res.json() as Promise<TeachResponse>) : Promise.reject(new Error(String(res.status)))))
        .then((data) => onNotice?.(teachMessage(b.name, data)))
        .catch(() => onNotice?.(`Couldn't save barcode ${unknown.upc} — you can teach it from the scanner later.`));
    }
    setMiss(null);
    setChoice(null);
    armIdle();
    onPick(b, meta);
  }

  function pickBottleForUnknown() {
    const guess = miss?.labelText ?? miss?.externalName ?? "";
    if (guess && query.trim().length < 2) onQuery(guess);
    searchRef.current?.focus();
  }

  async function snapLabel() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || busyRef.current) return;
    busyRef.current = true;
    setStatus("Reading the label…");
    try {
      const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const result = await identifyLabel(dataUrl, "image/jpeg");
      setLabelVia(result.via);
      // An unknown barcode's card shows what the label read alongside it.
      if (missRef.current) setMiss({ ...missRef.current, labelText: result.guess ?? null });
      if (result.candidates.length > 0) {
        setStatus(null);
        setChoice({ kind: "choose", upc: "", options: result.candidates.slice(0, 3).map(toBottle), externalName: result.guess ?? null });
      } else {
        setStatus(result.guess ? `The label reads “${result.guess}” — type to find it.` : "Couldn't read that label — type a name below.");
      }
    } catch {
      setStatus("Couldn't read that label — type a name below.");
    } finally {
      busyRef.current = false;
    }
  }

  /**
   * Picking a suggestion is a confirmation: it teaches the barcode (a pending
   * crowd claim until enough accounts agree, src/lib/upc-crowd.ts) or records
   * which label read was right — the same call the full scanner makes, without
   * shelving anything. Best effort: the pour never waits on it.
   */
  function pickSuggestion(b: ScanBottle) {
    const upc = choice?.upc || null;
    // With an unknown barcode on the card, `finish` sends the barcode confirm.
    if (!(missRef.current && teach) || upc) {
      void fetch("/api/scan/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(upc ? { upc, bottleId: b.id } : { bottleId: b.id, via: labelVia ?? undefined }),
      }).catch(() => {});
    }
    if (upc) {
      setChoice(null);
      onPick(b, { via: "barcode" });
      return;
    }
    finish(b, { via: "label" });
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);
  function onQuery(next: string) {
    setQuery(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = next.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchError(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      setSearchError(false);
      fetch(`/api/bottles/search?q=${encodeURIComponent(q)}`)
        .then((res) => {
          if (!res.ok) throw new Error("search failed");
          return res.json();
        })
        .then((data: { results?: SearchResult[] }) => setResults((data.results ?? []).slice(0, 6).map(toBottle)))
        .catch(() => {
          setResults([]);
          setSearchError(true);
        })
        .finally(() => setSearching(false));
    }, 250);
  }

  const showVideo = engine !== "native";
  return (
    <section aria-label="Choose the bottle" className="flex flex-col gap-2">
      {missingNotice && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          We couldn’t load that bottle. Scan or type it instead.
        </p>
      )}
      <div
        className={`card-viewfinder relative overflow-hidden rounded-lg border border-border bg-black/60 ${compact ? "h-[96px]" : "h-[150px]"}`}
        data-testid="pour-viewfinder"
      >
        {showVideo && <video ref={videoRef} muted playsInline aria-hidden className="absolute inset-0 h-full w-full object-cover" />}
        {/* Framing corners: decorative, the same guide the full scanner draws. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-[18%] inset-y-4 rounded-md border border-accent/50" />
        <span aria-hidden className="pointer-events-none absolute inset-x-[18%] top-1/2 h-px bg-accent/70" />
        {camera === "on" && (onKeepScanningChange || compact) && (
          <div className="absolute inset-x-0 top-0 flex justify-end gap-1.5 p-1.5">
            {onKeepScanningChange && (
              <button
                type="button"
                aria-pressed={Boolean(keepScanning)}
                onClick={() => onKeepScanningChange(!keepScanning)}
                className={`chip flex min-h-11 items-center gap-1.5 px-3 text-xs ${keepScanning ? "chip-active font-medium" : "bg-black/50"}`}
              >
                <Repeat size={14} strokeWidth={1.8} aria-hidden /> Keep scanning
              </button>
            )}
            {keepScanning && (
              <button type="button" onClick={stopNow} className="chip flex min-h-11 items-center gap-1.5 bg-black/50 px-3 text-xs">
                <CameraOff size={14} strokeWidth={1.8} aria-hidden /> Stop camera
              </button>
            )}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-2 pt-6 text-xs">
          <p role="status" aria-live="polite" className="min-w-0 text-foreground/90">
            {status ??
              (camera === "starting"
                ? "Starting the camera — it only reads the barcode or label."
                : camera === "on"
                  ? canDetect
                    ? "Point at the barcode — or snap the label."
                    : "Snap the label to identify it."
                  : camera === "paused"
                    ? keepScanning
                      ? "Camera paused to save battery — tap Resume for the next bottle."
                      : "Camera paused to save battery."
                    : "Camera is off — type a name below.")}
          </p>
          {camera === "on" && engine === "web" && (
            <button type="button" onClick={() => void snapLabel()} className="chip chip-active flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-xs font-medium">
              <ScanLine size={14} strokeWidth={1.8} aria-hidden /> Snap label
            </button>
          )}
          {camera === "on" && engine === "native" && (
            // MLKit owns the camera here, so there is no frame to grab; the
            // full scanner's native photo capture reads the label instead and
            // hands the bottle back to this sheet.
            <Link href="/scan?then=pour" className="chip chip-active flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-xs font-medium">
              <ScanLine size={14} strokeWidth={1.8} aria-hidden /> Snap label
            </Link>
          )}
          {(camera === "paused" || camera === "unavailable") && (
            <button
              type="button"
              onClick={() => {
                seenRef.current.clear();
                setCamera("starting");
                setAttempt((n) => n + 1);
              }}
              className="chip flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-xs"
            >
              {camera === "paused" ? <Camera size={14} strokeWidth={1.8} aria-hidden /> : <CameraOff size={14} strokeWidth={1.8} aria-hidden />}
              {camera === "paused" ? "Resume camera" : "Try camera again"}
            </button>
          )}
        </div>
      </div>

      {choice && (
        <div className="rounded-lg border border-accent/40 bg-surface px-2.5 py-2" role="group" aria-label="Is it one of these?">
          <p className="text-xs text-muted">
            Is it one of these?{choice.externalName ? ` The barcode says “${choice.externalName}”.` : ""}
          </p>
          <ul className="ledger mt-1">
            {choice.options.map((b) => (
              <li key={b.id}>
                <button type="button" onClick={() => pickSuggestion(b)} className="ledger-row w-full text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{b.name}</span>
                    <span className="block truncate text-xs text-muted">{bottleMeta(b)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {miss && (
        <section
          role="group"
          aria-label="Unknown barcode"
          data-testid="unknown-barcode"
          className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-surface px-2.5 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">We don’t know this barcode yet</p>
            <button
              type="button"
              aria-label="Dismiss unknown barcode"
              onClick={() => setMiss(null)}
              className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-foreground"
            >
              <X size={16} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted">Barcode</dt>
            <dd className="font-mono tabular-nums">{miss.upc}</dd>
            {miss.externalName && (
              <>
                <dt className="text-muted">Product lookup</dt>
                <dd className="min-w-0 break-words">{miss.externalName}</dd>
              </>
            )}
            <dt className="text-muted">Label reads</dt>
            <dd className="min-w-0 break-words">
              {miss.labelText ? `“${miss.labelText}”` : <span className="text-muted">not read yet</span>}
            </dd>
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={pickBottleForUnknown} className="chip chip-active flex min-h-11 items-center gap-1.5 px-3 text-xs font-medium">
              <Search size={14} strokeWidth={1.8} aria-hidden /> Pick bottle
            </button>
            {camera === "on" && engine === "web" && !miss.labelText && (
              <button type="button" onClick={() => void snapLabel()} className="chip flex min-h-11 items-center gap-1.5 px-3 text-xs">
                <ScanLine size={14} strokeWidth={1.8} aria-hidden /> Read the label
              </button>
            )}
          </div>
          <ToggleSwitch
            label="Teach this barcode"
            hint="The bottle you pick counts as a confirmation — two agreeing people add it for everyone."
            checked={teach}
            onChange={setTeach}
          />
        </section>
      )}

      {(!compact || miss) && (
        <>
      <label className="relative block">
        <span className="sr-only">Or type a bottle name</span>
        <Search size={16} strokeWidth={1.8} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="or type a name — “blant…”"
          className="h-11 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </label>

      {searching && <p role="status" className="px-1 text-xs text-muted">Searching…</p>}
      {searchError && <p className="px-1 text-xs text-muted">Search is unavailable right now — pick a recent bottle.</p>}
      {results.length > 0 && (
        <ul className="ledger" aria-label="Search results">
          {results.map((b) => (
            <li key={b.id}>
              <button type="button" onClick={() => finish(b, { via: "search" })} className="ledger-row w-full text-left">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  <span className="block truncate text-xs text-muted">{bottleMeta(b) || b.category}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim().length >= 2 && !searching && !searchError && results.length === 0 && (
        <p className="px-1 text-xs text-muted">No bottles match “{query.trim()}”.</p>
      )}

      {recent.length > 0 && (
        <div>
          <h2 className="section-label mb-1.5">Recent</h2>
          <ul className="flex flex-wrap gap-1.5" aria-label="Recent bottles">
            {recent.map((b) => (
              <li key={b.id}>
                <button type="button" onClick={() => finish(b, { via: "recent" })} className="chip min-h-11 px-3 text-xs text-foreground/90 hover:bg-surface-raised">
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
        </>
      )}
    </section>
  );
}
