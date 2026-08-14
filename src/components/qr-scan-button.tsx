"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Camera, ScanLine, X } from "lucide-react";
import { startNativeScan, type NativeScanSession } from "@/lib/native/barcode";

/**
 * Accept ONLY same-origin `/add/<handle>` paths from a scanned code — never
 * navigate to an arbitrary scanned URL. Exported for direct testing.
 */
export function parseAddPath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, typeof window === "undefined" ? undefined : window.location.origin);
  } catch {
    return null;
  }
  if (typeof window !== "undefined" && url.origin !== window.location.origin) return null;
  const match = /^\/add\/([a-z0-9_]{3,20})$/.exec(url.pathname);
  return match ? url.pathname : null;
}

type ScanState = "idle" | "scanning" | "unavailable";

/**
 * While a QR session is live the OS camera renders *behind* the WebView
 * (docs/NATIVE_APP.md §3.1) — but unlike /scan, the friends page is dense
 * with opaque cards that would cover the whole preview. This class hides the
 * app (visibility, so layout and scroll survive) and the portal overlay
 * below provides the framing UI. globals.css keys off it.
 */
const QR_SCANNING_CLASS = "qr-scanning";

/**
 * Scan a friend's QR code. Native path via `startNativeScan({ formats: "qr" })`
 * (docs/NATIVE_APP.md §3.1); on the web, or wherever native scanning isn't
 * available, falls back to a calm instruction rather than a broken camera UI —
 * the `BarcodeDetector` polyfill is deliberately not wired up here.
 */
export function QrScanButton() {
  const router = useRouter();
  const [state, setState] = useState<ScanState>("idle");
  // True once the camera session is adopted — the cue to swap the inline
  // "starting" row for the full-screen viewfinder overlay.
  const [live, setLive] = useState(false);
  const sessionRef = useRef<NativeScanSession | null>(null);
  // Bumped on every stop/unmount. startNativeScan awaits permissions and
  // camera startup, so a session can resolve AFTER the user cancelled or the
  // component unmounted — a stale generation means "stop it immediately"
  // rather than adopting it and leaving the camera running.
  const scanGenRef = useRef(0);

  useEffect(() => {
    return () => {
      scanGenRef.current += 1;
      document.documentElement.classList.remove(QR_SCANNING_CLASS);
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  async function stopScan() {
    scanGenRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    document.documentElement.classList.remove(QR_SCANNING_CLASS);
    setLive(false);
    setState("idle");
    await session?.stop();
  }

  async function startScan() {
    setState("scanning");
    const gen = ++scanGenRef.current;
    const session = await startNativeScan({
      formats: "qr",
      onBarcode: (raw) => {
        const path = parseAddPath(raw);
        if (!path) return;
        void stopScan();
        router.push(path);
      },
    });
    if (gen !== scanGenRef.current) {
      // Cancelled or unmounted while the camera was starting up.
      void session?.stop();
      return;
    }
    if (!session) {
      setState("unavailable");
      return;
    }
    sessionRef.current = session;
    document.documentElement.classList.add(QR_SCANNING_CLASS);
    setLive(true);
  }

  if (state === "scanning") {
    return (
      <>
        {!live && (
          <div className="card-flat flex items-center justify-between gap-3 p-3.5">
            <span className="flex items-center gap-2 text-sm text-muted">
              <ScanLine size={18} strokeWidth={1.8} className="text-accent" aria-hidden />
              Starting the camera…
            </span>
            <button
              type="button"
              onClick={() => void stopScan()}
              aria-label="Stop scanning"
              className="tap-target flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:text-foreground"
            >
              <X size={16} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
        )}
        {live &&
          typeof document !== "undefined" &&
          createPortal(
            // data-qr-overlay keeps this subtree visible while
            // html.qr-scanning hides everything else (globals.css).
            <div data-qr-overlay className="fixed inset-0 z-50 flex flex-col">
              <div className="pointer-events-none flex flex-1 items-center justify-center p-10">
                <div
                  aria-hidden
                  className="aspect-square w-full max-w-[18rem] rounded-3xl border-2 border-accent/70 shadow-[0_0_24px_rgba(232,161,60,0.25)]"
                />
              </div>
              <div className="flex items-center justify-between gap-3 bg-gradient-to-t from-black/70 to-transparent p-6 pb-10">
                <span className="flex items-center gap-2 text-sm text-foreground/90">
                  <ScanLine size={18} strokeWidth={1.8} className="text-accent" aria-hidden />
                  Point at a friend&apos;s code…
                </span>
                <button
                  type="button"
                  onClick={() => void stopScan()}
                  className="btn-secondary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm"
                >
                  <X size={16} strokeWidth={1.8} aria-hidden /> Stop
                </button>
              </div>
            </div>,
            document.body,
          )}
      </>
    );
  }

  if (state === "unavailable") {
    return (
      <div className="card-flat flex items-center gap-2 p-3.5 text-sm text-muted">
        <Camera size={18} strokeWidth={1.8} className="shrink-0" aria-hidden />
        Point your phone&apos;s camera at a friend&apos;s code, or type their handle.
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void startScan()}
      className="btn-secondary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm"
    >
      <ScanLine size={16} strokeWidth={1.8} aria-hidden /> Scan a code
    </button>
  );
}
