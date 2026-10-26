import { BRAND_NAME } from "@/lib/brand";

/**
 * Caskfolk's mark: a cask head (the ring and its three staves) that, read from
 * above, is also a round table with six seats (the copper arcs). Drawn on a
 * 64-unit grid; the ring and staves take `currentColor`, the seats the accent,
 * so it follows the theme. Source: the rebrand v2 board (brands.py MARKS).
 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="shrink-0"
    >
      <circle cx="32" cy="32" r="14" fill="none" stroke="currentColor" strokeWidth="3.4" />
      <path d="M25.5 20.3v23.4M32 18v28M38.5 20.3v23.4" stroke="currentColor" strokeWidth="1.4" opacity=".35" />
      <path
        d="M24.8 8.6A24.5 24.5 0 0 1 39.2 8.6M48.7 14.1A24.5 24.5 0 0 1 55.9 26.5M55.9 37.5A24.5 24.5 0 0 1 48.7 49.9M39.2 55.4A24.5 24.5 0 0 1 24.8 55.4M15.3 49.9A24.5 24.5 0 0 1 8.1 37.5M8.1 26.5A24.5 24.5 0 0 1 15.3 14.1"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="5.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark + name, the header lockup. The name is the accessible text. */
export function BrandLockup({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <BrandMark size={Math.round(size * 1.15)} />
      <span>{BRAND_NAME}</span>
    </span>
  );
}
