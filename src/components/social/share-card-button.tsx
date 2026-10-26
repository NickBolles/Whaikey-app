"use client";

import { useState } from "react";
import { share } from "@/lib/native/share";
import { BRAND_SLUG } from "@/lib/brand";

/** "shared" | "cancelled" (the person closed the sheet — stop there) | "unsupported" (fall back to the link). */
async function shareImageFile(url: string, title: string): Promise<"shared" | "cancelled" | "unsupported"> {
  try {
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return "unsupported";
    const blob = await (await fetch(url)).blob();
    const file = new File([blob], `${BRAND_SLUG}-card.png`, { type: "image/png" });
    if (!nav.canShare({ files: [file] })) return "unsupported";
    await nav.share({ files: [file], title });
    return "shared";
  } catch (err) {
    return err instanceof DOMException && err.name === "AbortError" ? "cancelled" : "unsupported";
  }
}

/**
 * Make a share card and hand it to the native share sheet (docs/SOCIAL.md
 * §7.10). Nothing is posted anywhere: the person picks where it goes. The
 * story (1080×1920) is what's shared; the link card (1200×630) is offered too.
 */
export function ShareCardButton({ body, title, label = "Share card" }: { body: Record<string, unknown>; title: string; label?: string }) {
  const [links, setLinks] = useState<{ story: string; link: string } | null>(null);
  const [error, setError] = useState(false);
  async function go() {
    setError(false);
    const res = await fetch("/api/cards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res?.ok) return setError(true);
    const json = (await res.json()) as { story: string; link: string };
    const abs = { story: `${window.location.origin}${json.story}`, link: `${window.location.origin}${json.link}` };
    setLinks(abs);
    // Share the rendered story PNG itself where the platform can take a file
    // (Web Share Level 2 — mobile browsers and the iOS/Android WebViews that
    // expose it); otherwise fall back to the link through the native seam.
    if ((await shareImageFile(abs.story, title)) !== "unsupported") return;
    await share({ title, url: abs.story }).catch(() => undefined);
  }
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" onClick={() => void go()} className="btn-secondary w-fit px-4 py-2 text-sm">
        {label}
      </button>
      {links && (
        <p className="text-xs text-muted">
          <a href={links.story} target="_blank" rel="noreferrer" className="text-accent">
            Story image
          </a>
          {" · "}
          <a href={links.link} target="_blank" rel="noreferrer" className="text-accent">
            Link card
          </a>
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-muted">
          Couldn&rsquo;t make the card — try again.
        </p>
      )}
    </div>
  );
}
