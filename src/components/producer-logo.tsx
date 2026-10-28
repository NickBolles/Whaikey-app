"use client";

import { useState } from "react";
import { monogram } from "@/lib/bottle-art";

/**
 * A producer's (distillery/brand) mark for identification
 * (docs/DATA_SOURCES.md §5.4), served from our own origin by
 * /api/brand-logo/[key].
 *
 * Always on a white plate with a hairline border, so a dark wordmark reads in
 * dark mode and a white one still reads in light mode — and the mark itself
 * is never recoloured. `object-contain` inside a fixed box: a logo is never
 * stretched or cropped. Lazy and async-decoded with explicit size hints. If
 * the request fails the plate becomes the monogram roundel (`fallback`), or
 * disappears (`fallback="none"`) where the silhouette already carries one.
 */
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
  if (logoKey && !failed) {
    const pad = Math.max(2, Math.round(size * 0.12));
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-black/10 bg-white ${className}`}
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
