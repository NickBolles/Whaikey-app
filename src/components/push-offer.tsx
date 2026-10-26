"use client";

import { useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { isNativeApp } from "@/lib/native/platform";
import { enablePush, pushPermissionState } from "@/lib/native/push";
import { SOCIAL_INTERACTION_EVENT, loadOfferState, mayOffer, saveOfferState } from "@/lib/native/push-offer";
import { BRAND_NAME } from "@/lib/brand";

/**
 * The app's own pre-permission card, shown after a first social interaction
 * in the native app (src/lib/native/push-offer.ts). Only "Turn on" spends the
 * one-time OS prompt; "Not now" just closes it.
 */
export function PushOffer() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let checking = false;
    async function onInteraction() {
      if (checking || !isNativeApp()) return;
      checking = true;
      try {
        const now = Date.now();
        const state = loadOfferState();
        if (!mayOffer(state, now)) return;
        const permission = await pushPermissionState().catch(() => "unavailable" as const);
        if (permission !== "prompt") {
          // Already answered at the OS level (or no push here): nothing to offer, ever.
          if (permission === "granted" || permission === "denied") saveOfferState({ ...state, done: true });
          return;
        }
        saveOfferState({ ...state, shown: state.shown + 1, lastShownAt: now });
        setNote(null);
        setOpen(true);
      } finally {
        checking = false;
      }
    }
    const handler = () => void onInteraction();
    window.addEventListener(SOCIAL_INTERACTION_EVENT, handler);
    return () => window.removeEventListener(SOCIAL_INTERACTION_EVENT, handler);
  }, []);

  if (!open) return null;

  async function turnOn() {
    setBusy(true);
    const state = await enablePush().catch(() => "unavailable" as const);
    setBusy(false);
    if (state === "unavailable") {
      // Nothing was decided (plugin missing or the request threw): keep the
      // offer alive for a later interaction instead of ending it.
      setNote("Couldn't turn notifications on just now — you can try again from Settings.");
      return;
    }
    saveOfferState({ ...loadOfferState(), done: true });
    if (state === "denied") {
      setNote(`Notifications are off for ${BRAND_NAME} in your phone's settings.`);
      return;
    }
    setOpen(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="push-offer-title"
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 mx-auto max-w-lg rounded-xl border border-accent/40 bg-surface p-3 shadow-lg"
    >
      <div className="flex items-start gap-2.5">
        <BellRing size={18} strokeWidth={1.8} aria-hidden className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p id="push-offer-title" className="text-sm font-medium">
            Know when friends answer?
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Replies, follows and tasting-night invites — never reminders to pour. Change it any time in Settings.
          </p>
          {note && <p className="mt-1 text-xs text-danger">{note}</p>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void turnOn()} disabled={busy} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-60">
              {busy ? "Turning on…" : "Turn on"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary min-h-11 px-4 text-sm">
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
          className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:text-foreground"
        >
          <X size={16} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    </div>
  );
}
