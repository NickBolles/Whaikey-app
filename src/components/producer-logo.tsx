"use client";

import { useState } from "react";
import { monogram } from "@/lib/bottle-art";

/**
 * A producer's (distillery/brand) mark for identification
 * (docs/DATA_SOURCES.md §5.4), served from our own origin by
 * /api/brand-logo/[key].
 *
 * On a white plate with a hairline border, so a dark wordmark reads in dark
 * mode — and the mark itself is never recoloured. A white-on-transparent mark
 * (Bowmore, Bushmills, Penderyn…) would vanish on white, so once it loads we
 * sample it ({@link markTone}) and swap to a dark plate (#138). `object-contain` inside a fixed box: a logo is never
 * stretched or cropped. Lazy and async-decoded with explicit size hints. If
 * the request fails the plate becomes the monogram roundel (`fallback`), or
 * disappears (`fallback="none"`) where the silhouette already carries one.
 */
const LIGHT_PLATE = "border-black/10 bg-white";
const DARK_PLATE = "border-white/10 bg-[#2b2620]";
/** Per-key result, so a list of the same brand samples it once per page. */
const toneCache = new Map<string, "light" | "dark">();

/**
 * "light" when the mark's opaque pixels are almost all near-white (alpha-
 * weighted mean luminance ≥ 0.8), i.e. it would disappear on a white plate.
 * Same-origin image, so the canvas is never tainted; anything unreadable
 * (no canvas, decode error) counts as "dark" and keeps the white plate.
 */
export function markTone(img: HTMLImageElement): "light" | "dark" {
  try {
    const n = 24;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "dark";
    ctx.drawImage(img, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    let weight = 0;
    let lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a < 0.12) continue;
      weight += a;
      lum += a * ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
    }
    return weight > 0 && lum / weight >= 0.8 ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ProducerLogo({
  logoKey,
  name,
  size = 20,
  color = "#4c4438",
  fallback = "monogram",
  className = "",
}: {
  logoKey: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  color?: string;
  fallback?: "monogram" | "none";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [tone, setTone] = useState<"light" | "dark" | undefined>(undefined);
  if (logoKey && !failed) {
    const plate = (tone ?? toneCache.get(logoKey)) === "light" ? DARK_PLATE : LIGHT_PLATE;
    const pad = Math.max(2, Math.round(size * 0.12));
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] border ${plate} ${className}`}
        style={{ width: size, height: size, padding: pad }}
        data-testid="producer-logo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- own-origin, pre-sized and CDN-cached; the optimizer would only spend quota */}
        <img
          src={`/api/brand-logo/${logoKey}`}
          alt={name ? `${name} logo` : ""}
          width={size - pad * 2}
          height={size - pad * 2}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
          onLoad={(e) => {
            if (!toneCache.has(logoKey)) toneCache.set(logoKey, markTone(e.currentTarget));
            setTone(toneCache.get(logoKey));
          }}
          onError={() => setFailed(true)}
        />
      </span>
    );
  }
  if (fallback === "none") return null;
  const letters = monogram(name);
  return (
    <span
      aria-hidden
      data-testid="producer-monogram"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-[#f3ead6] ${className}`}
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.round(size * (letters.length > 1 ? 0.38 : 0.48)),
        fontFamily: "var(--font-brand-display), serif",
      }}
    >
      {letters}
    </span>
  );
}
