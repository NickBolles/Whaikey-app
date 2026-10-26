import type { ReactNode } from "react";

/**
 * Paper's pull-quote, Ledger-sized (docs/DESIGN.md "Editorial", 2026-10-26):
 * a tasting note set as the one large italic line on a surface.
 *
 * - `variant="hang"` (default) hangs the quote off an amber rule with a
 *   ghosted opening mark — feed cards and journal entries.
 * - `variant="center"` centres it between double rules — the bottle page's
 *   one editorial moment.
 *
 * The quote marks are typographic (CSS/ghosted glyph), so `text` is passed
 * bare. `kicker` sits above, `byline` below; both are optional.
 */
export function PullQuote({
  text,
  kicker,
  byline,
  variant = "hang",
  className = "",
}: {
  text: string;
  kicker?: ReactNode;
  byline?: ReactNode;
  variant?: "hang" | "center";
  className?: string;
}) {
  return (
    <figure
      className={`pull-quote ${variant === "center" ? "pull-quote-center" : ""} ${className}`.trim()}
      data-testid="pull-quote"
    >
      {kicker && <figcaption className="kicker mb-1.5">{kicker}</figcaption>}
      <blockquote>{text}</blockquote>
      {byline && <div className="mt-1.5 text-xs text-muted not-italic">{byline}</div>}
    </figure>
  );
}

/**
 * Whether a note reads as a quote. A two-word note ("Smoky, sweet") set at
 * 18px italic looks like a typo with a frame round it; under this length the
 * caller shows it as an ordinary line instead.
 */
export const PULL_QUOTE_MIN_CHARS = 24;

export function isQuotable(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length >= PULL_QUOTE_MIN_CHARS;
}
