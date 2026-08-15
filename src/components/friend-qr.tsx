"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode, X } from "lucide-react";

/**
 * Shows the current user's add-me code: a QR pointing at
 * `/add/[handle]` (docs/SOCIAL.md §7.2 — every add path lands there).
 * Generated client-side with the `qrcode` package — pure JS, no network.
 */
export function FriendQr({ handle }: { handle: string }) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || dataUrl || error) return;
    let cancelled = false;
    const url = `${window.location.origin}/add/${handle}`;
    QRCode.toDataURL(url, { margin: 1, width: 256 })
      .then((value) => {
        if (!cancelled) setDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, dataUrl, error, handle]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm"
      >
        <QrCode size={16} strokeWidth={1.8} aria-hidden /> Show my code
      </button>
    );
  }

  return (
    <div className="card-flat flex flex-col items-center gap-3 p-4">
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- local data URL, no next/image benefit
        <img
          src={dataUrl}
          alt={`QR code to add @${handle} on Whaikey`}
          width={180}
          height={180}
          className="rounded-xl border border-border-subtle bg-white p-2"
        />
      ) : error ? (
        <p className="text-sm text-danger">Couldn&apos;t generate your code — try again.</p>
      ) : (
        <div className="flex h-[180px] w-[180px] items-center justify-center text-sm text-muted">Generating…</div>
      )}
      <p className="text-sm text-muted">@{handle}</p>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="tap-target inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground"
      >
        <X size={14} strokeWidth={1.8} aria-hidden /> Hide code
      </button>
    </div>
  );
}
