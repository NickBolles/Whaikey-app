import { compareFlavorNotes, type FlavorCompareGroup } from "@/lib/flavor-compare";
import { FlavorChip } from "@/components/flavor-chip";

function ChipList({ groups }: { groups: FlavorCompareGroup[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {groups.flatMap((group) =>
        group.leafIds.map((leafId) => (
          <li key={leafId}>
            <FlavorChip leafId={leafId} />
          </li>
        )),
      )}
    </ul>
  );
}

export interface ShareComparisonProps {
  /** The viewer's own flavor tags on this bottle (union across all their pours). */
  mine: Record<string, number> | null | undefined;
  /** The sharer's flavor tags on the shared pour. */
  theirs: Record<string, number> | null | undefined;
}

/**
 * US-1: the viewer-private comparison rendered on `/s/[code]` when the
 * signed-in viewer has their own tasting notes on the shared bottle. Nothing
 * here is ever shown to, or stored for, the sharer.
 */
export function ShareComparison({ mine, theirs }: ShareComparisonProps) {
  const { both, onlyMine, onlyTheirs } = compareFlavorNotes(mine, theirs);
  const noOverlap = both.length === 0;

  return (
    <section className="card flex flex-col gap-5 p-5">
      <div>
        <p className="section-label">Your notes, compared</p>
        <h2 className="font-display text-xl font-semibold mt-1">You&apos;ve tasted this too</h2>
      </div>

      {noOverlap ? (
        <p className="text-sm text-muted">No descriptors in common — that&apos;s a conversation.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="section-label">You both got…</h3>
          <ChipList groups={both} />
        </div>
      )}

      {onlyTheirs.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="section-label">They got — you didn&apos;t</h3>
          <ChipList groups={onlyTheirs} />
        </div>
      )}

      {onlyMine.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="section-label">You got — they didn&apos;t</h3>
          <ChipList groups={onlyMine} />
        </div>
      )}
    </section>
  );
}
