"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, CameraOff, ScanLine, Search } from "lucide-react";
import { isNativeApp } from "@/lib/native/platform";
import { startNativeScan, type NativeScanSession } from "@/lib/native/barcode";
import { haptic } from "@/lib/native/haptics";
import { identifyLabel } from "@/lib/label-scan";
import { bottleMeta, decideScan, productCode, type ScanBottle, type ScanDecision, type UpcLookup } from "./scan-decision";

/** D16: the camera pauses itself after ~2 minutes of logging. */
export const CAMERA_AUTO_PAUSE_MS = 120_000;
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
}: {
  onPick: (bottle: ScanBottle, meta: PickMeta) => void;
  missingNotice?: boolean;
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
  const [missUpc, setMissUpc] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ScanBottle[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [recent, setRecent] = useState<ScanBottle[]>([]);
  const [attempt, setAttempt] = useState(0);

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
        if (decision.kind === "exact") {
          haptic("lock");
          setStatus(null);
          onPick(decision.bottle, { via: "barcode", alternatives: decision.alternatives });
        } else if (decision.kind === "choose") {
          haptic("tap");
          setStatus(null);
          setChoice(decision);
        } else {
          setStatus(null);
          setMissUpc(decision.upc);
        }
      } catch {
        seenRef.current.delete(code);
        setStatus("Couldn't look that barcode up — type a name below.");
      } finally {
        busyRef.current = false;
      }
    },
    [onPick],
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
    const pauseTimer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      if (interval) clearInterval(interval);
      void native?.stop();
      stopCamera();
      setCamera("paused");
    }, CAMERA_AUTO_PAUSE_MS);

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
      clearTimeout(pauseTimer);
      if (interval) clearInterval(interval);
      void native?.stop();
      stopCamera();
    };
  }, [attempt, resolveBarcode, stopCamera]);

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
      <div className="card-viewfinder relative h-[150px] overflow-hidden rounded-lg border border-border bg-black/60" data-testid="pour-viewfinder">
        {showVideo && <video ref={videoRef} muted playsInline aria-hidden className="absolute inset-0 h-full w-full object-cover" />}
        {/* Framing corners: decorative, the same guide the full scanner draws. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-[18%] inset-y-4 rounded-md border border-accent/50" />
        <span aria-hidden className="pointer-events-none absolute inset-x-[18%] top-1/2 h-px bg-accent/70" />
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
                    ? "Camera paused to save battery."
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
                <button type="button" onClick={() => onPick(b, { via: choice.upc ? "barcode" : "label" })} className="ledger-row w-full text-left">
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

      {missUpc && (
        <p className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs text-muted">
          We don’t know barcode {missUpc} yet. Type the name below, or{" "}
          <Link href="/scan" className="text-accent underline-offset-2 hover:underline">teach the scanner</Link> — two confirmations add it for everyone.
        </p>
      )}

      <label className="relative block">
        <span className="sr-only">Or type a bottle name</span>
        <Search size={16} strokeWidth={1.8} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
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
              <button type="button" onClick={() => onPick(b, { via: "search" })} className="ledger-row w-full text-left">
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
                <button type="button" onClick={() => onPick(b, { via: "recent" })} className="chip min-h-11 px-3 text-xs text-foreground/90 hover:bg-surface-raised">
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
