import { RemoteBottleImage } from "@/components/remote-bottle-image";
import { bottleShape, displayableImage, liquidTint, monogram, monogramColor, type BottleShape } from "@/lib/bottle-art";

export interface BottleArtProps {
  name: string;
  category: string;
  distillery?: string | null;
  region?: string | null;
  country?: string | null;
  /** `bottles.image_url` — renders only when the policy allows (src/lib/bottle-art.ts). */
  imageUrl?: string | null;
  /** Cask finish words ("Oloroso sherry"), which tint the liquid. */
  cask?: string | null;
  /** Rendered height in px; the width follows the silhouette (≈ 0.42×). */
  height?: number;
  className?: string;
}

/** Body outline per silhouette, in a 40×100 box. Neck + shoulders + body. */
const OUTLINES: Record<BottleShape, string> = {
  squat: "M16 4h8v14c0 3 9 6 9 14v60c0 3-2 5-5 5H12c-3 0-5-2-5-5V32c0-8 9-11 9-14z",
  tall: "M17 2h6v22c0 4 8 7 8 13v57c0 2-2 4-4 4H13c-2 0-4-2-4-4V37c0-6 8-9 8-13z",
  square: "M16 4h8v12c0 2 10 4 10 10v67c0 2-2 4-4 4H10c-2 0-4-2-4-4V26c0-6 10-8 10-10z",
  flask: "M16 4h8v12c0 4 11 6 11 13v63c0 3-2 5-5 5H10c-3 0-5-2-5-5V29c0-7 11-9 11-13z",
};

/**
 * A bottle picture for lists, cards and the bottle page. A licensed catalog
 * image when one may be shown (served through the Next image optimizer, so
 * it is cached rather than hotlinked per view); otherwise a generated
 * silhouette — shaped by style, the liquid tinted by cask and region, the
 * label carrying the distillery's monogram. Never a broken image.
 */
export function BottleArt({ name, category, distillery, region, country, imageUrl, cask, height = 64, className = "" }: BottleArtProps) {
  const width = Math.round(height * 0.42);
  const remote = displayableImage(imageUrl);
  const shape = bottleShape(category);
  const tint = liquidTint({ name: cask ? `${name} ${cask}` : name, category, region });
  const badge = monogramColor({ category, region, country });
  const letters = monogram(distillery || name);
  const outline = OUTLINES[shape];
  const clipId = `bottle-${shape}`;
  const silhouette = (
    <svg
      viewBox="0 0 40 100"
      width={width}
      height={height}
      aria-hidden
      data-testid="bottle-art"
      className={`shrink-0 ${className}`}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={outline} />
        </clipPath>
      </defs>
      {/* Glass, then the liquid filling the body up to the shoulder. */}
      <path d={outline} fill="var(--surface-raised)" />
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="36" width="40" height="64" fill={tint} opacity="0.92" />
        <rect x="9" y="38" width="3" height="54" fill="#fff" opacity="0.12" />
      </g>
      <path d={outline} fill="none" stroke="var(--border)" strokeWidth="1.2" />
      {/* Cap and the label with the monogram. */}
      <rect x={shape === "tall" ? 16 : 15} y="0" width={shape === "tall" ? 8 : 10} height="6" rx="1.5" fill={badge} />
      <rect x="8" y="52" width="24" height="24" rx="2.5" fill="#f3ead6" />
      <circle cx="20" cy="64" r="8.5" fill={badge} />
      <text
        x="20"
        y="64"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={letters.length > 1 ? 7.5 : 9.5}
        fontWeight="700"
        fill="#f3ead6"
        style={{ fontFamily: "var(--font-brand-display), serif" }}
      >
        {letters}
      </text>
    </svg>
  );
  if (remote) {
    // A 2x density hint is enough for a list thumbnail; the optimizer picks
    // the nearest configured width and caches it (docs/DATA_SOURCES.md §5.5).
    return <RemoteBottleImage src={remote} width={width} height={height} fallback={silhouette} className={className} />;
  }
  return silhouette;
}
