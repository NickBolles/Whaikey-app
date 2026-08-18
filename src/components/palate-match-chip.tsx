import { Sparkles } from "lucide-react";

/**
 * "You taste alike" as a number (docs/SOCIAL.md US-16). Rendered only when a
 * match could actually be computed — both palates carry enough rated pours and
 * the viewer follows this person — so it never has to say 0% out of ignorance.
 *
 * Deliberately not a rank or a badge: it describes the pair, not either
 * person, and nothing anywhere sorts people by it.
 */
export function PalateMatchChip({
  matchPercent,
  className,
}: {
  matchPercent: number;
  className?: string;
}) {
  return (
    <span
      data-testid="palate-match"
      className={`chip chip-active inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-0.5 text-[11px] font-medium ${className ?? ""}`}
    >
      <Sparkles size={12} strokeWidth={1.8} aria-hidden />
      {matchPercent}% palate match
    </span>
  );
}
