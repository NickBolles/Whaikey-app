"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Check, Copy, QrCode, Share2, X } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";
import { QrScanButton } from "@/components/qr-scan-button";

/** The add-me link every friend-add path lands on (docs/SOCIAL.md §7.2). */
export function addLink(origin: string, handle: string): string {
  return `${origin}/add/${handle}`;
}

type Loaded = { handle: string } | { handle: null; reason: "no-profile" | "error" };

/**
 * "My code" — the friend-add QR one tap from the Social header and your own
 * profile (owner feedback 2026-10-26: "make finding my QR code easier").
 *
 * Opens a sheet with the QR, your @handle, a native share sheet (falling back
 * to copying the link) and "Scan a friend's code", so a table of people at a
 * distillery can add each other without hunting through People. The handle
 * is passed in when the page already has it, otherwise read on open from
 * /api/social/profile; with no profile yet the sheet points at claiming one.
 */
export function MyCodeButton({ handle: knownHandle, variant = "icon" }: { handle?: string | null; variant?: "icon" | "button" }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(knownHandle ? { handle: knownHandle } : null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const handle = loaded?.handle ?? null;

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    fetch("/api/social/profile")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { profile?: { handle?: string } | null }) => {
        if (cancelled) return;
        setLoaded(body.profile?.handle ? { handle: body.profile.handle } : { handle: null, reason: "no-profile" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ handle: null, reason: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  useEffect(() => {
    if (!open || !handle || qr) return;
    let cancelled = false;
    QRCode.toDataURL(addLink(window.location.origin, handle), { margin: 1, width: 320 })
      .then((value) => {
        if (!cancelled) setQr(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, handle, qr]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function share() {
    if (!handle) return;
    const url = addLink(window.location.origin, handle);
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title: `Add @${handle} on ${BRAND_NAME}`, text: `Add me on ${BRAND_NAME}: @${handle}`, url });
        return;
      } catch (err) {
        // The user closing the share sheet is not a failure worth a fallback.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  const trigger =
    variant === "icon" ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="My code"
        aria-haspopup="dialog"
        className="tap-target flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-raised hover:text-foreground"
      >
        <QrCode size={20} strokeWidth={1.8} aria-hidden />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="btn-secondary tap-target inline-flex min-h-11 items-center gap-1.5 px-4 text-sm"
      >
        <QrCode size={16} strokeWidth={1.8} aria-hidden /> My code
      </button>
    );

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setOpen(false)}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-sm rounded-t-2xl border border-border bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lg sm:rounded-2xl"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 id={titleId} className="font-display text-lg font-semibold">
                  My code
                </h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground"
                >
                  <X size={18} strokeWidth={1.8} aria-hidden />
                </button>
              </div>
              {loaded?.handle === null ? (
                <p className="mt-2 text-sm text-muted">
                  {loaded.reason === "no-profile" ? (
                    <>
                      Pick a handle first — your code points at it.{" "}
                      <a href="/friends/people" className="text-accent">
                        Claim one →
                      </a>
                    </>
                  ) : (
                    "Couldn't load your code — try again."
                  )}
                </p>
              ) : (
                <div className="mt-2 flex flex-col items-center gap-2">
                  <p className="text-center text-sm text-muted">Friends scan this to add you — no typing.</p>
                  <div data-testid="my-code-qr" className="flex h-[212px] w-[212px] items-center justify-center rounded-xl border border-border-subtle bg-white p-2">
                    {qr && handle ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local data URL, no next/image benefit
                      <img src={qr} alt={`QR code to add @${handle} on ${BRAND_NAME}`} width={196} height={196} />
                    ) : (
                      <span className="text-sm text-neutral-500">Generating…</span>
                    )}
                  </div>
                  {handle && <p className="font-display text-base font-semibold">@{handle}</p>}
                  <div className="mt-1 flex w-full flex-col items-stretch gap-2 [&>button]:justify-center">
                    <button
                      type="button"
                      onClick={() => void share()}
                      disabled={!handle}
                      className="btn-primary tap-target inline-flex min-h-11 items-center justify-center gap-1.5 px-3 text-sm disabled:opacity-60"
                    >
                      {copied ? <Check size={16} strokeWidth={1.8} aria-hidden /> : typeof navigator !== "undefined" && "share" in navigator ? <Share2 size={16} strokeWidth={1.8} aria-hidden /> : <Copy size={16} strokeWidth={1.8} aria-hidden />}
                      {copied ? "Link copied" : "Share link"}
                    </button>
                    <QrScanButton />
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
