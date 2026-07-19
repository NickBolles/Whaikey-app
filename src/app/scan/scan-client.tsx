"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Check, ImageUp, Keyboard, ScanLine, Undo2, X } from "lucide-react";
import { RELATIONSHIPS, type Relationship } from "@/db/schema";
import { isValidUpc, normalizeUpc } from "@/lib/upc";
import type { BottleSearchResult } from "@/lib/ai/tools";
import { CategoryChip } from "@/components/category-chip";

/**
 * Rapid-fire scanning: camera barcode loop (BarcodeDetector where available),
 * manual code entry (works with hardware wedge scanners), and label-photo
 * fallback. Confirmed scans add to the shelf in one round trip and feed the
 * crowdsourced UPC map, so the flow is "beep… beep… beep" — a 50-bottle
 * collection should take minutes, not an evening.
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

interface AddedEntry {
  userBottleId: string | null;
  bottleId: string;
  name: string;
  upc: string | null;
  relationship: Relationship;
  updated: boolean;
}

/** Decision sheet shown when a scan needs the user to pick / search. */
interface PendingDecision {
  upc: string | null;
  title: string;
  subtitle: string | null;
  options: BottleSearchResult[];
}

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  own: "I own it",
  tried: "Tried it",
  wishlist: "Wishlist",
};

// Minimal typings for the (Chromium-only, for now) shape-detection API.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

const BARCODE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];
/** Ignore re-detections of the same code within this window (ms). */
const REPEAT_MS = 4000;
const DETECT_INTERVAL_MS = 300;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor ?? null;
}

export function ScanClient() {
  const [cameraState, setCameraState] = useState<"starting" | "on" | "unavailable">("starting");
  const [relationship, setRelationship] = useState<Relationship>("own");
  const [added, setAdded] = useState<AddedEntry[]>([]);
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "warn" } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors for the detector loop, which runs outside React's render cycle.
  const pausedRef = useRef(false);
  const relationshipRef = useRef(relationship);
  const addedRef = useRef(added);
  useEffect(() => {
    pausedRef.current = pending !== null || busy;
    relationshipRef.current = relationship;
    addedRef.current = added;
  }, [pending, busy, relationship, added]);

  const showToast = useCallback((text: string, kind: "ok" | "warn" = "ok") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /** Record the confirmation (crowdsourcing the mapping) and shelve the bottle. */
  const confirmAdd = useCallback(
    async (upc: string | null, bottle: BottleSearchResult) => {
      setBusy(true);
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
        const data = (await res.json()) as {
          userBottle: { id: string } | null;
        };
        const updated = res.status !== 201;
        setPending(null);
        setAdded((prev) => [
          {
            userBottleId: data.userBottle?.id ?? null,
            bottleId: bottle.id,
            name: bottle.name,
            upc,
            relationship: relationshipRef.current,
            updated,
          },
          ...prev,
        ]);
        navigator.vibrate?.(60);
        showToast(updated ? `${bottle.name} — shelf updated` : `Added ${bottle.name}`);
      } catch {
        showToast("Couldn't save that one — try again", "warn");
      } finally {
        setBusy(false);
      }
    },
    [showToast],
  );

  /** Resolve a scanned/typed code and decide: auto-add, pick, or fall back. */
  const submitCode = useCallback(
    async (raw: string): Promise<boolean> => {
      const code = normalizeUpc(raw);
      if (!code || !isValidUpc(code)) {
        setManualError("That doesn't look like a UPC/EAN barcode.");
        return false;
      }
      setManualError(null);

      if (addedRef.current.some((a) => a.upc === code)) {
        showToast("Already scanned this session", "warn");
        return true;
      }

      setBusy(true);
      try {
        const res = await fetch("/api/scan/upc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ upc: code }),
        });
        if (!res.ok) throw new Error(`scan failed (${res.status})`);
        const data = (await res.json()) as ScanResponse;

        if (data.matches.length === 1) {
          setBusy(false);
          await confirmAdd(data.upc, data.matches[0]);
          return true;
        }
        if (data.matches.length > 1) {
          setPending({
            upc: data.upc,
            title: "Which bottle is this?",
            subtitle: "This barcode is shared across bottlings — pick yours.",
            options: data.matches,
          });
          return true;
        }
        if (data.candidates.length > 0) {
          setPending({
            upc: data.upc,
            title: "Is it one of these?",
            subtitle: data.externalName ? `Barcode lookup says “${data.externalName}”.` : null,
            options: data.candidates,
          });
          return true;
        }
        setPending({
          upc: data.upc,
          title: "New one on us 🥃",
          subtitle:
            "We don't know this barcode yet. Find the bottle below or snap the label — your confirmation teaches Whaikey for everyone.",
          options: [],
        });
        return true;
      } catch {
        showToast("Scan failed — check your connection and retry", "warn");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [confirmAdd, showToast],
  );

  // Camera + detection loop.
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    (async () => {
      const Detector = barcodeDetectorCtor();
      if (!navigator.mediaDevices?.getUserMedia || !Detector) {
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

        const detector = new Detector({ formats: BARCODE_FORMATS });
        interval = setInterval(async () => {
          if (pausedRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue;
            if (!value) return;
            const now = Date.now();
            const last = lastCodeRef.current;
            if (last && last.code === value && now - last.at < REPEAT_MS) return;
            lastCodeRef.current = { code: value, at: now };
            void submitCode(value);
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
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [submitCode]);

  const onManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim() || busy) return;
    const ok = await submitCode(manualCode);
    // Keep the code visible when it was rejected so the user can fix a typo.
    if (ok) setManualCode("");
  };

  const onLabelFile = async (file: File) => {
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const [head, base64] = dataUrl.split(",", 2);
      const mediaType = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
      const res = await fetch("/api/scan-label", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      if (res.status === 503) {
        showToast("Label scan needs the AI key — use search below", "warn");
        setPending((p) => p ?? { upc: null, title: "Find your bottle", subtitle: null, options: [] });
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
      setPending((p) => ({
        upc: p?.upc ?? null,
        title: data.candidates.length > 0 ? "Is it one of these?" : "New one on us 🥃",
        subtitle: guess ? `The label reads “${guess}”.` : "Couldn't read much off that label.",
        options: data.candidates,
      }));
    } catch {
      showToast("Couldn't read that photo — try again", "warn");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (entry: AddedEntry) => {
    setAdded((prev) => prev.filter((a) => a !== entry));
    if (entry.userBottleId && !entry.updated) {
      await fetch(`/api/user-bottles/${entry.userBottleId}`, { method: "DELETE" }).catch(() => {});
      showToast(`Removed ${entry.name}`);
    } else {
      showToast(`${entry.name} kept its earlier shelf entry`, "warn");
    }
  };

  const manualVisible = cameraState !== "on" || manualOpen;

  return (
    <div className="px-4 pt-6 flex flex-col gap-5 pb-6">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">Scan your shelf</h1>
        <p className="text-muted text-sm mt-1">
          Barcode after barcode — each confirmed scan lands straight in your bar.
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
          <div className="absolute bottom-0 inset-x-0 p-3 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent">
            <span className="text-sm text-foreground/90 flex items-center gap-2">
              <ScanLine size={18} strokeWidth={1.8} aria-hidden className="text-accent" />
              {cameraState === "on" ? "Point at a barcode" : "Starting camera…"}
            </span>
            <button
              type="button"
              onClick={() => setManualOpen((v) => !v)}
              className="btn-secondary px-3 py-2 text-xs font-medium flex items-center gap-1.5"
            >
              <Keyboard size={16} strokeWidth={1.8} aria-hidden /> Type it
            </button>
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
              disabled={busy || manualCode.trim().length === 0}
              className="btn-primary px-5 py-3 text-sm font-medium disabled:opacity-50"
            >
              {busy ? "…" : "Scan"}
            </button>
          </div>
          {manualError && (
            <p role="alert" className="text-sm text-danger">
              {manualError}
            </p>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="btn-secondary mt-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2"
          >
            <ImageUp size={18} strokeWidth={1.8} aria-hidden />
            Snap the label instead
          </button>
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
        </form>
      )}

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

      {/* Session tray */}
      <section aria-label="Scanned this session">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="section-label">Scanned this session ({added.length})</h2>
          {added.length > 0 && (
            <Link href="/bar" className="text-sm text-accent font-medium">
              Done → My Bar
            </Link>
          )}
        </div>
        {added.length === 0 ? (
          <div className="card p-8 text-center flex flex-col items-center gap-2">
            <div aria-hidden className="text-4xl mb-1">🥃</div>
            <p className="font-display text-lg font-semibold">Line up the bottles</p>
            <p className="text-sm text-muted leading-relaxed max-w-xs">
              Scan one after another — no forms between scans. Undo anything from this list.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {added.map((entry, i) => (
              <li
                key={`${entry.bottleId}-${i}`}
                className="card-flat flex items-center justify-between gap-3 p-3.5"
              >
                <div className="min-w-0 flex items-center gap-2.5">
                  <Check size={18} strokeWidth={2} aria-hidden className="text-success shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{entry.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {entry.updated ? "shelf updated" : RELATIONSHIP_LABELS[entry.relationship]}
                      {entry.upc ? ` · ${entry.upc}` : ""}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void undo(entry)}
                  className="btn-secondary shrink-0 px-3 py-2 text-xs font-medium flex items-center gap-1.5"
                >
                  <Undo2 size={14} strokeWidth={1.8} aria-hidden /> Undo
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending && (
        <DecisionSheet
          pending={pending}
          busy={busy}
          onPick={(bottle) => void confirmAdd(pending.upc, bottle)}
          onLabelPhoto={() => fileRef.current?.click()}
          onClose={() => setPending(null)}
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
  pending,
  busy,
  onPick,
  onLabelPhoto,
  onClose,
}: {
  pending: PendingDecision;
  busy: boolean;
  onPick: (bottle: BottleSearchResult) => void;
  onLabelPhoto: () => void;
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

  const options = query.trim() ? results : pending.options;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={pending.title}>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="relative card rounded-b-none p-5 max-h-[80dvh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold">{pending.title}</h2>
            {pending.subtitle && (
              <p className="text-sm text-muted mt-1 leading-relaxed">{pending.subtitle}</p>
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
                  disabled={busy}
                  onClick={() => onPick(b)}
                  className="btn-primary shrink-0 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  This one
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="scan-sheet-search" className="section-label">
            {pending.options.length > 0 ? "None of these? Search" : "Search the catalog"}
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
        </div>
      </div>
    </div>
  );
}
