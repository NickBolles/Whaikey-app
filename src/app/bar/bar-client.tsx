"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  hasPublishedProducerFlavorNotes,
  type BarFlavorHeat,
  type BarRow,
  type FlavorCalibration,
  type FlavorHeatScope,
} from "@/lib/bar";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import {
  BarFlavorWheel,
  type CalibrationMark,
  type FlavorSelection,
} from "@/components/bar-flavor-wheel";
import { BottleListRow } from "@/components/bottle-list-row";
import { FlavorHeatLegend } from "@/components/flavor-wheel";

/** BarRow with dates possibly serialized to strings (API JSON responses). */
export type Row = Omit<BarRow, "createdAt" | "updatedAt" | "purchaseDate"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  purchaseDate: Date | string | null;
};

/**
 * Which bottles are in view. This used to be two controls — a section tab and a
 * flavor-map scope — that selected the same rows under different names, with a
 * hidden rule resetting one when the other changed.
 */
type Collection = "own" | "tried" | "wishlist" | "all";

/**
 * Whose palate paints the wheel. "Mine" and the old "My palate" were always the
 * same evidence counted two ways — your tags, raw or weighted by rating — so
 * that pair is a switch inside Mine rather than a mode of its own.
 */
type Lens = "mine" | "label" | "compare";

/** Heat for every (source, scope) pair, keyed `${source}:${scope}`. */
export type FlavorHeatMatrix = Record<string, BarFlavorHeat>;

/** Your notes against the label's, per shelf scope. */
export type CalibrationMatrix = Record<FlavorHeatScope, FlavorCalibration>;

/** The user's taste fingerprint, already reduced to wheel heat by the server. */
export interface PalateHeat {
  wedges: Record<string, number>;
  leaves: Record<string, number>;
  topWedgeIds: string[];
  sampleSize: number;
}

/** Mine always works; the other two need something published to draw. */
function lensAvailable(lens: Lens, calibration: FlavorCalibration): boolean {
  if (lens === "label") return calibration.publishedNoteBottles > 0;
  if (lens === "compare") return calibration.hasComparison;
  return true;
}

const LENSES: { key: Lens; label: string; caption: string }[] = [
  { key: "mine", label: "Mine", caption: "My notes" },
  { key: "label", label: "Label", caption: "The label" },
  { key: "compare", label: "Compare", caption: "Mine vs label" },
];

const BUCKET_COPY: Record<CalibrationMark, { label: string; className: string }> = {
  shared: { label: "Shared", className: "text-taste-shared" },
  blind: { label: "Blind spot", className: "text-taste-blind" },
  signature: { label: "Yours alone", className: "text-taste-signature" },
};

const COLLECTIONS: { key: Collection; label: string }[] = [
  { key: "own", label: "My bar" },
  { key: "tried", label: "Tried" },
  { key: "wishlist", label: "Wishlist" },
  { key: "all", label: "Everything" },
];

/** Collections the pill row can express; the rest live in the panel. */
const QUICK_COLLECTIONS: Collection[] = ["own", "wishlist"];

/**
 * The primary filter row under the header: bottle states plus the wishlist,
 * single-select, tap the active pill to clear it. "Tried" and "Everything"
 * remain a panel choice — they are collections, not bottle states.
 */
type StatusPill = "open" | "sealed" | "wishlist" | "finished";

const STATUS_PILLS: { key: StatusPill; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "sealed", label: "Sealed" },
  { key: "wishlist", label: "Wishlist" },
  { key: "finished", label: "Finished" },
];

/** A sealed bottle may predate status tracking; null status on an owned row reads as sealed. */
function matchesStatusPill(row: Row, pill: Exclude<StatusPill, "wishlist">): boolean {
  if (pill === "open") return row.status === "open";
  if (pill === "sealed") return row.status === "sealed" || row.status == null;
  return row.status === "finished";
}

/** One quiet line per pill — an empty state, not an illustration. */
const PILL_EMPTY_COPY: Record<StatusPill, string> = {
  open: "Nothing open right now — crack a seal and log the first pour.",
  sealed: "No sealed bottles waiting.",
  wishlist: "Nothing on the wishlist yet — save bottles you're hunting.",
  finished: "No finished bottles yet.",
};

/** What the wheel is describing, in the sentence under it. */
const SCOPE_BLURB: Record<FlavorHeatScope, string> = {
  own: "the bottles you own",
  tried: "bottles you’ve tasted but don’t own",
  all: "every bottle you’ve owned or tasted",
};

/** Wishlist bottles are untasted, so no flavor map describes them. */
function scopeFor(collection: Collection): FlavorHeatScope {
  return collection === "all" ? "all" : collection === "tried" ? "tried" : "own";
}

const CATEGORY_LABELS: Record<string, string> = {
  bourbon: "Bourbon",
  rye: "Rye",
  "american-single-malt": "American single malt",
  "american-other": "American other",
  "scotch-single-malt": "Single malt scotch",
  "scotch-blended": "Blended scotch",
  irish: "Irish",
  japanese: "Japanese",
  canadian: "Canadian",
  world: "World",
};

interface FilterOption {
  id: string;
  label: string;
  test: (row: Row) => boolean;
}

interface FilterGroup {
  id: string;
  label: string;
  options: FilterOption[];
}

const published = (row: Row) => hasPublishedProducerFlavorNotes(row.bottle);

/**
 * Which bucket a descriptor falls into, for the filters that ask about one.
 *
 * Where the comparison has an opinion, defer to it: the Compare summary, the
 * wheel's marks and these filters all appear on the same screen, so they must
 * not disagree about what counts as a blind spot or as yours alone. Two cases
 * this gets right that a per-bottle test does not:
 *
 *   - a descriptor caught on one of two bottles is still a blind spot by the
 *     hit-rate rule, even though it has been tagged at some point;
 *   - a descriptor *some* label names is never "yours alone", even on a bottle
 *     whose own label happens to omit it.
 *
 * Only for descriptors the comparison has never seen — on bottles carrying
 * published notes you have not tasted — does the blind test fall back to "you
 * have never once reached for this". Nothing is yours alone under that
 * fallback: naming it is what would make it yours, and you have not.
 */
function bucketTest(
  calibration: FlavorCalibration,
  everTagged: Set<string>,
): (leafId: string, bucket: CalibrationMark) => boolean {
  return (leafId, bucket) => {
    const cal = calibration.leaves[leafId];
    if (cal) return cal.bucket === bucket;
    return bucket === "blind" && !everTagged.has(leafId);
  };
}

/**
 * The filter vocabulary for the bottles currently in view. Groups that cannot
 * apply are left out rather than shown as controls that silently empty the
 * list: bottle state and price paid describe a bottle you own, and the
 * calibration group needs published notes to compare against.
 *
 * Options are OR within a group and AND across groups — the rule every filter
 * panel already teaches.
 */
function buildFilterGroups(
  rows: Row[],
  collection: Collection,
  isBucket: (leafId: string, bucket: CalibrationMark) => boolean,
): FilterGroup[] {
  const groups: FilterGroup[] = [];
  const ownedInView = collection === "own" || collection === "all";

  if (ownedInView) {
    groups.push({
      id: "bottle",
      label: "Bottle",
      options: [
        { id: "open", label: "Open", test: (r) => r.status === "open" },
        { id: "sealed", label: "Sealed", test: (r) => r.status === "sealed" },
        { id: "low", label: "Running low", test: (r) => r.status === "open" && (r.fillLevel ?? 100) < 25 },
      ],
    });
  }

  groups.push({
    id: "notes",
    label: "My notes",
    options: [
      { id: "noted", label: "Tasted & noted", test: (r) => Object.keys(r.personalFlavorTags).length > 0 },
      { id: "unnoted", label: "No notes yet", test: (r) => Object.keys(r.personalFlavorTags).length === 0 },
      { id: "rated4", label: "Rated 4★ and up", test: (r) => (r.personalRating ?? 0) >= 4 },
    ],
  });

  if (rows.some(published)) {
    groups.push({
      id: "calibration",
      label: "Against the label",
      options: [
        {
          id: "blind",
          label: "Has a blind spot",
          test: (r) =>
            published(r) &&
            Object.keys(r.bottle.producerFlavorTags ?? {}).some((id) => isBucket(id, "blind")),
        },
        {
          id: "signature",
          label: "Has a note of your own",
          test: (r) =>
            published(r) &&
            Object.keys(r.personalFlavorTags).some((id) => isBucket(id, "signature")),
        },
      ],
    });
  }

  // Only the styles actually on the shelf: a fixed list of ten categories would
  // be mostly dead options for every real collection.
  const categories = [...new Set(rows.map((r) => r.bottle.category))].sort();
  if (categories.length > 1) {
    groups.push({
      id: "style",
      label: "Style",
      options: categories.map((category) => ({
        id: `style:${category}`,
        label: CATEGORY_LABELS[category] ?? category,
        test: (r: Row) => r.bottle.category === category,
      })),
    });
  }

  if (ownedInView) {
    groups.push({
      id: "price",
      label: "Price paid",
      options: [
        { id: "under50", label: "Under $50", test: (r) => r.purchasePrice != null && r.purchasePrice < 50 },
        {
          id: "mid",
          label: "$50–100",
          test: (r) => r.purchasePrice != null && r.purchasePrice >= 50 && r.purchasePrice <= 100,
        },
        { id: "over100", label: "Over $100", test: (r) => (r.purchasePrice ?? 0) > 100 },
      ],
    });
  }

  return groups;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

const EMPTY_HEAT: BarFlavorHeat = { wedges: {}, leaves: {}, topWedgeIds: [], hasHeat: false };

const EMPTY_CALIBRATION: FlavorCalibration = {
  leaves: {},
  publishedNoteBottles: 0,
  comparedBottles: 0,
  agreement: 0,
  blindSpotIds: [],
  signatureIds: [],
  hasComparison: false,
};

export function BarClient({
  initialRows,
  flavorHeat,
  calibration,
  palate,
}: {
  initialRows: Row[];
  flavorHeat: FlavorHeatMatrix;
  calibration: CalibrationMatrix;
  palate: PalateHeat;
}) {
  const [rows] = useState<Row[]>(initialRows);
  const [collection, setCollection] = useState<Collection>("own");
  const [statusPill, setStatusPill] = useState<Exclude<StatusPill, "wishlist"> | null>(null);
  const [checks, setChecks] = useState<string[]>([]);
  const [lens, setLens] = useState<Lens>("mine");
  const [weightByRating, setWeightByRating] = useState(false);
  const [selectedFlavorIds, setSelectedFlavorIds] = useState<string[]>([]);
  const flavorScope = scopeFor(collection);

  const ownRows = useMemo(() => rows.filter((r) => r.relationship === "own"), [rows]);
  const wishlistRows = useMemo(() => rows.filter((r) => r.relationship === "wishlist"), [rows]);
  const triedRows = useMemo(() => rows.filter((r) => r.relationship === "tried"), [rows]);

  const stats = useMemo(() => {
    let totalSpent = 0;
    let estValue = 0;
    let openCount = 0;
    for (const r of ownRows) {
      const qty = r.quantity ?? 1;
      if (r.purchasePrice != null) totalSpent += r.purchasePrice * qty;
      const unit = r.estValue ?? r.bottle.avgPrice;
      if (unit != null) estValue += unit * qty;
      if (r.status === "open") openCount += 1;
    }
    return { bottleCount: ownRows.length, openCount, totalSpent, estValue };
  }, [ownRows]);

  const collectionRows = useMemo(
    () =>
      collection === "own"
        ? ownRows
        : collection === "tried"
          ? triedRows
          : collection === "wishlist"
            ? wishlistRows
            : [...ownRows, ...triedRows],
    [collection, ownRows, triedRows, wishlistRows],
  );
  // Spans the whole shelf, not the collection in view: "never tagged" has to
  // mean never, or switching collections would change what counts as one.
  const everTagged = useMemo(
    () => new Set(rows.flatMap((r) => Object.keys(r.personalFlavorTags))),
    [rows],
  );
  // The pill narrows the owned shelf by bottle state before anything else
  // sees it; the wishlist pill is a collection, handled by changePill.
  const pillRows = useMemo(
    () =>
      statusPill && collection === "own"
        ? collectionRows.filter((row) => matchesStatusPill(row, statusPill))
        : collectionRows,
    [collectionRows, collection, statusPill],
  );
  const filterGroups = useMemo(
    () =>
      buildFilterGroups(
        collectionRows,
        collection,
        bucketTest(calibration[scopeFor(collection)] ?? EMPTY_CALIBRATION, everTagged),
      ),
    [collectionRows, collection, calibration, everTagged],
  );
  // Checks that survive a collection change but no longer have a control would
  // filter the list from somewhere the user cannot see, so they are dropped.
  const activeChecks = useMemo(() => {
    const available = new Set(filterGroups.flatMap((g) => g.options.map((o) => o.id)));
    return checks.filter((id) => available.has(id));
  }, [checks, filterGroups]);
  const activeRows = useMemo(() => {
    if (activeChecks.length === 0) return pillRows;
    return pillRows.filter((row) =>
      filterGroups.every((group) => {
        const on = group.options.filter((o) => activeChecks.includes(o.id));
        return on.length === 0 || on.some((o) => o.test(row));
      }),
    );
  }, [pillRows, filterGroups, activeChecks]);
  // The palate describes the drinker, not a shelf, so it ignores scope entirely.
  const palateHeatMap: BarFlavorHeat = useMemo(
    () => ({
      wedges: palate.wedges,
      leaves: palate.leaves,
      topWedgeIds: palate.topWedgeIds,
      // Either ring is enough to draw. Liked and disliked descriptors in one
      // family can cancel at wedge level while a descriptor stays positive —
      // reporting that as a blank page would hide a preference we do know.
      hasHeat:
        palate.sampleSize > 0 &&
        (Object.keys(palate.wedges).length > 0 || Object.keys(palate.leaves).length > 0),
    }),
    [palate],
  );
  const activeCalibration = calibration[flavorScope] ?? EMPTY_CALIBRATION;
  // Label and Compare are only offered where published notes exist, so neither
  // can become a permanently empty control the way "Producer" was.
  const hasPublishedNotes = activeCalibration.publishedNoteBottles > 0;
  const canCompare = activeCalibration.hasComparison;
  // changeCollection normalizes the stored lens; this stays as the guard for
  // the paths that change the row set without a collection change.
  const effectiveLens: Lens = lensAvailable(lens, activeCalibration) ? lens : "mine";
  // Compare paints the label's claim and lets agreement ride in the marks, so
  // its fill is the producer heat.
  const activeFlavorHeat =
    effectiveLens === "mine"
      ? weightByRating
        ? palateHeatMap
        : flavorHeat[`personal:${flavorScope}`] ?? EMPTY_HEAT
      : flavorHeat[`producer:${flavorScope}`] ?? EMPTY_HEAT;
  const marks = useMemo(() => {
    if (effectiveLens !== "compare") return undefined;
    const out: Record<string, CalibrationMark> = {};
    for (const cal of Object.values(activeCalibration.leaves)) out[cal.leafId] = cal.bucket;
    return out;
  }, [effectiveLens, activeCalibration]);
  const selectedProfileFamilies = useMemo(
    () =>
      FLAVOR_WHEEL.filter((wedge) => wedge.leaves.every((leaf) => selectedFlavorIds.includes(leaf.id))).map(
        (wedge) => wedge.id,
      ),
    [selectedFlavorIds],
  );
  // Wishlist bottles are untasted, so no flavor map describes them and their
  // list is never filtered by one.
  const flavorFilterable = collection !== "wishlist";
  const filteredRows = useMemo(() => {
    if (!flavorFilterable || selectedFlavorIds.length === 0) return activeRows;
    // Mine filters on your own tags — including when weighted by rating, since
    // the palate is built from those same notes ("what do I own that tastes
    // like what I like"). Label and Compare both ask about the label's claim,
    // so tapping a blind spot lists the bottles whose notes name it.
    const fromOwnNotes = effectiveLens === "mine";
    return activeRows.filter((row) => {
      const tags = fromOwnNotes
        ? row.personalFlavorTags
        : hasPublishedProducerFlavorNotes(row.bottle)
          ? row.bottle.producerFlavorTags ?? {}
          : {};
      const profileMatches =
        fromOwnNotes &&
        selectedProfileFamilies.some((wedgeId) => (row.bottle.flavorProfile?.[wedgeId] ?? 0) > 0);
      return profileMatches || selectedFlavorIds.some((leafId) => (tags[leafId] ?? 0) > 0);
    });
  }, [activeRows, flavorFilterable, effectiveLens, selectedFlavorIds, selectedProfileFamilies]);

  function changeLens(next: Lens) {
    setLens(next);
    setSelectedFlavorIds([]);
  }

  function rowsForCollection(next: Collection): Row[] {
    if (next === "own") return ownRows;
    if (next === "tried") return triedRows;
    if (next === "wishlist") return wishlistRows;
    return [...ownRows, ...triedRows];
  }

  function changeCollection(next: Collection) {
    setCollection(next);
    if (next !== "own") setStatusPill(null);
    setSelectedFlavorIds([]);
    // Drop the checks the new collection has no control for, rather than only
    // hiding them: a filter that disappears from the bar and then resurrects
    // when you come back is worse than one that was never dropped.
    const nextGroups = buildFilterGroups(
      rowsForCollection(next),
      next,
      bucketTest(calibration[scopeFor(next)] ?? EMPTY_CALIBRATION, everTagged),
    );
    const available = new Set(nextGroups.flatMap((g) => g.options.map((o) => o.id)));
    setChecks((current) => current.filter((id) => available.has(id)));
    // Same reasoning as the segment clearing both slots for a panel-chosen
    // collection: while the lens sits on a shelf that cannot support it, the
    // control marks Mine as selected, and a stored "compare" would make that
    // aria-selected a lie the moment you came back.
    const nextCalibration = calibration[scopeFor(next)] ?? EMPTY_CALIBRATION;
    setLens((current) => (lensAvailable(current, nextCalibration) ? current : "mine"));
  }

  /** Single-select with an off state: tapping the active pill clears it. */
  function changePill(pill: StatusPill) {
    if (pill === "wishlist") {
      if (collection === "wishlist") {
        changeCollection("own");
      } else {
        changeCollection("wishlist");
      }
      return;
    }
    const next = statusPill === pill ? null : pill;
    if (collection !== "own") changeCollection("own");
    setStatusPill(next);
  }

  const activePill: StatusPill | null =
    collection === "wishlist" ? "wishlist" : collection === "own" ? statusPill : null;

  function clearFilters() {
    setChecks([]);
    setSelectedFlavorIds([]);
  }

  function toggleCheck(id: string) {
    setChecks((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  function toggleFlavor(selection: FlavorSelection) {
    setSelectedFlavorIds((current) => {
      const allSelected = selection.leafIds.every((id) => current.includes(id));
      return allSelected
        ? current.filter((id) => !selection.leafIds.includes(id))
        : Array.from(new Set([...current, ...selection.leafIds]));
    });
  }

  const shelfTotal = ownRows.length + triedRows.length + wishlistRows.length;

  return (
    <div className="px-4 pt-5 pb-10 flex flex-col gap-6">
      <div className="flex flex-col gap-3.5">
        <header className="flex items-baseline justify-between">
          <h1 className="font-display text-[27px] leading-tight font-semibold">My bar</h1>
          <span className="font-mono text-sm text-muted tabular-nums" aria-label={`${shelfTotal} bottles`}>
            {shelfTotal}
          </span>
        </header>

        {/* The primary filter, directly under the header: bottle states plus
            the wishlist, one line at 390px, tap the active pill to clear it. */}
        <div role="group" aria-label="Bottle state" className="flex gap-1.5">
          {STATUS_PILLS.map((pill) => {
            const active = activePill === pill.key;
            return (
              <button
                key={pill.key}
                type="button"
                aria-pressed={active}
                onClick={() => changePill(pill.key)}
                className={`tap-target inline-flex min-h-9 flex-1 items-center justify-center rounded-full border px-2 text-[12.5px] font-medium transition-colors ${
                  active ? "chip-active" : "text-muted hover:text-foreground"
                }`}
                style={active ? undefined : { borderColor: "#2e2519" }}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
      </div>

      {collection === "own" && (
        /* The only money surface on this page: spend and est. value stay inside
           the owner's own-collection view and never join a social projection. */
        <section aria-label="Bar stats" className="card-flat flex divide-x divide-border-subtle">
          <Stat value={String(stats.bottleCount)} label="bottles" />
          <Stat value={String(stats.openCount)} label="open" />
          <Stat value={money(stats.totalSpent)} label="spent" />
          <Stat value={money(stats.estValue)} label="est. value" />
        </section>
      )}

      {/* The wheel reads first and filters the list further down: a tap lands
          as a removable token in the FilterBar directly above that list, so the
          feedback sits adjacent to what it narrows. */}
      {flavorFilterable && (
        <FlavorMapSection
          heat={activeFlavorHeat}
          lens={effectiveLens}
          weightByRating={weightByRating}
          onWeightChange={setWeightByRating}
          hasPublishedNotes={hasPublishedNotes}
          canCompare={canCompare}
          calibration={activeCalibration}
          marks={marks}
          rows={activeRows}
          scope={flavorScope}
          onLensChange={changeLens}
          selectedFlavorIds={selectedFlavorIds}
          onToggleFlavor={toggleFlavor}
          onClearFlavors={() => setSelectedFlavorIds([])}
          shownCount={filteredRows.length}
          totalCount={activeRows.length}
          rowNoun={collection === "tried" ? "tastings" : "bottles"}
          topWedgeIds={palate.topWedgeIds}
        />
      )}

      <FilterBar
        collection={collection}
        onCollectionChange={changeCollection}
        counts={{
          own: ownRows.length,
          tried: triedRows.length,
          wishlist: wishlistRows.length,
          all: ownRows.length + triedRows.length,
        }}
        groups={filterGroups}
        checks={activeChecks}
        onToggleCheck={toggleCheck}
        flavorIds={selectedFlavorIds}
        onRemoveFlavor={(id) => setSelectedFlavorIds((ids) => ids.filter((f) => f !== id))}
        onClear={clearFilters}
        shownCount={filteredRows.length}
        totalCount={collectionRows.length}
      />

      {filteredRows.length === 0 ? (
        activePill && pillRows.length === 0 ? (
          // Per-pill empty state: one quiet line, no illustration.
          <p className="px-1 text-sm text-muted">{PILL_EMPTY_COPY[activePill]}</p>
        ) : collectionRows.length > 0 ? (
          // A shelf with bottles on it is never "waiting" — if nothing shows,
          // the filters are too narrow, and the way out is to widen them.
          <NoMatches onClear={clearFilters} />
        ) : (
          <EmptyState collection={collection} />
        )
      ) : (
        <ul className="flex flex-col gap-[9px]">
          {filteredRows.map((row) => {
            const own = row.relationship === "own";
            const meta = [
              row.bottle.distilleryName ?? CATEGORY_LABELS[row.bottle.category] ?? row.bottle.category,
              row.quantity > 1 ? `×${row.quantity}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            const level =
              row.status === "finished" ? 0 : row.status === "open" ? row.fillLevel : 100;
            return (
              <li key={row.id}>
                <BottleListRow
                  href={`/bottles/${row.bottleId}`}
                  name={row.bottle.name}
                  score={row.personalRating}
                  meta={meta}
                  metaRight={
                    own && row.status === "open" && row.fillLevel != null
                      ? `${row.fillLevel}% left`
                      : row.relationship === "wishlist" && row.bottle.avgPrice != null
                        ? `~$${row.bottle.avgPrice.toFixed(0)}`
                        : null
                  }
                  spine={own ? { level, bottleId: row.bottleId } : null}
                  flavorTags={row.personalFlavorTags}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One wheel, one control deciding whose palate lights it. The lens lives on the
 * wheel's own card rather than in the page header, because it changes the
 * picture and not the list — the three loose chip rows above it never said so.
 *
 * Label and Compare are hidden until the bottles in view actually carry
 * published notes: an always-visible control that shows every user an empty
 * state is worse than no control.
 */
function FlavorMapSection({
  heat,
  lens,
  weightByRating,
  onWeightChange,
  hasPublishedNotes,
  canCompare,
  calibration,
  marks,
  rows,
  scope,
  onLensChange,
  selectedFlavorIds,
  onToggleFlavor,
  onClearFlavors,
  shownCount,
  totalCount,
  rowNoun,
  topWedgeIds,
}: {
  heat: BarFlavorHeat;
  lens: Lens;
  weightByRating: boolean;
  onWeightChange: (weighted: boolean) => void;
  hasPublishedNotes: boolean;
  canCompare: boolean;
  calibration: FlavorCalibration;
  marks: Record<string, CalibrationMark> | undefined;
  rows: Row[];
  scope: FlavorHeatScope;
  onLensChange: (lens: Lens) => void;
  selectedFlavorIds: string[];
  onToggleFlavor: (selection: FlavorSelection) => void;
  onClearFlavors: () => void;
  shownCount: number;
  totalCount: number;
  rowNoun: string;
  topWedgeIds: string[];
}) {
  const scopeBlurb = SCOPE_BLURB[scope];
  const lensMeta = LENSES.find((l) => l.key === lens) ?? LENSES[0];
  const isPalate = lens === "mine" && weightByRating;
  const isCompare = lens === "compare";
  const leaning = isPalate
    ? topWedgeIds.map((id) => FLAVOR_WHEEL.find((w) => w.id === id)?.label ?? id)
    : [];
  const availableLenses = LENSES.filter(
    (l) => l.key === "mine" || (l.key === "label" && hasPublishedNotes) || (l.key === "compare" && canCompare),
  );
  // One descriptor at a time gets the detail treatment: the panel answers
  // "what did I say instead", which only makes sense about a single flavor.
  const focusedLeafId = selectedFlavorIds.length === 1 ? selectedFlavorIds[0] : null;

  return (
    <section aria-label="Flavor map">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-label">Flavor map</h2>
        {availableLenses.length > 1 && (
          <div
            role="tablist"
            aria-label="Flavor map lens"
            className="inline-flex rounded-full border border-border-subtle bg-background p-1 gap-0.5"
          >
            {availableLenses.map((l) => (
              <button
                key={l.key}
                role="tab"
                aria-selected={lens === l.key}
                onClick={() => onLensChange(l.key)}
                className={`tap-target inline-flex min-h-9 items-center rounded-full px-3 text-xs font-medium transition-colors ${
                  lens === l.key ? "chip-active" : "text-muted hover:text-foreground"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Full width, under the toggles: squeezed beside them it wrapped to a
          four-line column on a phone. */}
      <p className="mt-2 mb-3 text-xs text-muted">
        {isCompare
          ? "Your tagged notes read against the published ones. The label is one opinion, not an answer key."
          : isPalate
            ? "Where your ratings lean, weighted by how recently you poured; tagged notes refine its details."
            : lens === "label"
              ? `What the distilleries claim about ${scopeBlurb}.`
              : `The wheel maps ${scopeBlurb}; tagged notes refine its details.`}
      </p>

      {/* Outside the card on purpose: with no tagged notes yet the card falls
          back to an empty state, and the drinker still needs a way to reach the
          rating-weighted view that may well have signal. */}
      {lens === "mine" && (
        <button
          onClick={() => onWeightChange(!weightByRating)}
          aria-pressed={weightByRating}
          className={`chip tap-target mb-3 inline-flex min-h-9 items-center px-3 text-[11px] font-medium ${
            weightByRating ? "chip-active" : "hover:text-foreground"
          }`}
        >
          Weight by rating
        </button>
      )}

      {heat.hasHeat ? (
        <div className="card p-4 flex flex-col items-center gap-3">
          {/* Above the wheel: it is the one-line answer, and the wheel's own
              descriptor controls would otherwise push it off the fold. */}
          {leaning.length > 0 && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-[11px] text-muted uppercase tracking-[0.14em]">You lean toward</p>
              <ul className="flex flex-wrap justify-center gap-2" aria-label="Palate leanings">
                {leaning.map((label) => (
                  <li key={label} className="chip px-3 py-1 text-xs">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isCompare && <CalibrationSummary calibration={calibration} />}
          <BarFlavorWheel
            wedgeHeat={heat.wedges}
            leafHeat={heat.leaves}
            caption={lensMeta.caption}
            subCaption={isCompare ? `${calibration.comparedBottles} compared` : "family · group · flavor"}
            selectedIds={selectedFlavorIds}
            onToggle={onToggleFlavor}
            marks={marks}
          />
          {isCompare ? <CalibrationLegend /> : <FlavorHeatLegend leafHeat={heat.leaves} />}
          {selectedFlavorIds.length > 0 && (
            <>
              <div className="flex w-full flex-wrap items-center justify-center gap-2" aria-label="Active flavor filters">
                {selectedFlavorIds.map((id) => (
                  <button key={id} onClick={() => onToggleFlavor({ id, label: leafLabel(id) ?? id, leafIds: [id] })} className="chip chip-active px-3 py-1.5 text-xs">
                    {leafLabel(id) ?? id} ×
                  </button>
                ))}
                <button onClick={onClearFlavors} className="min-h-11 px-2 text-xs text-muted hover:text-foreground underline-offset-2 hover:underline">
                  Clear
                </button>
              </div>
              <p className="text-xs text-muted">
                Showing {shownCount} of {totalCount} {rowNoun}
              </p>
            </>
          )}
          {isCompare && focusedLeafId && (
            <DescriptorCalibration leafId={focusedLeafId} calibration={calibration} rows={rows} />
          )}
        </div>
      ) : (
        <div className="card p-6 text-center flex flex-col items-center gap-2">
          <div aria-hidden className="text-3xl">{isPalate ? "📖" : "🎯"}</div>
          <p className="font-display text-base font-semibold">
            {isPalate
              ? "Your palate is still a blank page"
              : lens === "mine"
                ? "No personal flavor notes yet"
                : "No published flavor notes yet"}
          </p>
          <p className="text-sm text-muted max-w-[30ch] leading-relaxed">
            {isPalate
              ? "Rate a few pours and your flavor fingerprint appears here."
              : lens === "mine"
                ? `Log a pour and tag what you taste to map ${scopeBlurb}.`
                : "Published bottle notes appear here as the catalog and scanner are enriched."}
          </p>
        </div>
      )}
    </section>
  );
}

/** The one-line answer, above the wheel: caught, missed, and yours alone. */
function CalibrationSummary({ calibration }: { calibration: FlavorCalibration }) {
  const stats = [
    {
      value: `${Math.round(calibration.agreement * 100)}%`,
      label: "label notes caught",
      className: "text-taste-shared",
    },
    {
      value: String(calibration.blindSpotIds.length),
      label: "blind spots",
      className: "text-taste-blind",
    },
    {
      value: String(calibration.signatureIds.length),
      label: "yours alone",
      className: "text-taste-signature",
    },
  ];
  return (
    <div className="grid w-full grid-cols-3 gap-2" aria-label="Calibration summary">
      {stats.map((s) => (
        <div key={s.label} className="card-flat flex flex-col justify-between p-2.5">
          <div className={`stat-number text-lg leading-none ${s.className}`}>{s.value}</div>
          <div className="mt-1.5 text-[10px] text-muted">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

function CalibrationLegend() {
  const items: Array<{ mark: CalibrationMark; text: string }> = [
    { mark: "shared", text: "you both call it" },
    { mark: "blind", text: "the label does, you don’t" },
    { mark: "signature", text: "you do, the label doesn’t" },
  ];
  return (
    <ul className="flex w-full flex-col gap-1.5 text-[11px] text-muted" aria-label="Calibration legend">
      {items.map(({ mark, text }) => (
        <li key={mark} className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0"
            style={{
              background: mark === "blind" ? "transparent" : `var(--taste-${mark})`,
              border: mark === "blind" ? "1.5px solid var(--taste-blind)" : undefined,
              borderRadius: mark === "signature" ? 2 : 999,
              transform: mark === "signature" ? "rotate(45deg)" : undefined,
            }}
          />
          <span className="text-foreground">{BUCKET_COPY[mark].label}</span> — {text}
        </li>
      ))}
    </ul>
  );
}

/**
 * "What did I say instead?" — the reason this feature is worth building. For a
 * missed descriptor it shows, bottle by bottle, what the label said next to
 * what you wrote in the same family, and names the substitution outright.
 */
function DescriptorCalibration({
  leafId,
  calibration,
  rows,
}: {
  leafId: string;
  calibration: FlavorCalibration;
  rows: Row[];
}) {
  const cal = calibration.leaves[leafId];
  const label = leafLabel(leafId) ?? leafId;
  const wedge = wedgeForLeaf(leafId);
  const bottles = rows.filter(
    (row) =>
      hasPublishedProducerFlavorNotes(row.bottle) &&
      ((row.bottle.producerFlavorTags?.[leafId] ?? 0) > 0 || (row.personalFlavorTags[leafId] ?? 0) > 0),
  );
  if (!cal || bottles.length === 0) return null;

  const substitute = cal.substitutes[0];
  const bucket = BUCKET_COPY[cal.bucket];
  const line =
    cal.bucket === "blind"
      ? cal.labelBottles === 0
        ? // Blind because a label names it, but only on a bottle you have not
          // poured — so there is no hit rate to report, and quoting the
          // comparison count here would read as "on 0 bottles".
          `${label} is on the label of ${bottleCount(cal.shelfLabelBottles)} you haven’t poured yet, so there’s nothing to compare against — but you do reach for it elsewhere.`
        : substitute
          ? `The label names ${label} on ${bottleCount(cal.labelBottles)} and you caught it ${cal.sharedBottles === 0 ? "none" : cal.sharedBottles} of those times. On ${substitute.bottles} of them you wrote ${leafLabel(substitute.leafId) ?? substitute.leafId} instead.`
          : `The label names ${label} on ${bottleCount(cal.labelBottles)}; you tagged it ${cal.sharedBottles}×.`
      : cal.bucket === "shared"
        ? `You and the label both call it on ${cal.sharedBottles} of ${bottleCount(cal.labelBottles)}.`
        : `You tag ${label} on ${bottleCount(cal.yourBottles)}. No label on your shelf mentions it — this one is yours.`;

  return (
    <div className="w-full rounded-xl border border-border-subtle bg-surface overflow-hidden">
      <div className="p-3 border-b border-border-subtle">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          <span className={`chip px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${bucket.className}`}>
            {bucket.label}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-muted leading-relaxed">{line}</p>
      </div>
      <ul>
        {bottles.map((row) => {
          const published = row.bottle.producerFlavorTags ?? {};
          const familyOf = (tags: Record<string, number>) =>
            Object.keys(tags).filter((id) => wedgeForLeaf(id) === wedge);
          return (
            <li key={row.id} className="p-3 border-t border-border-subtle first:border-t-0">
              <div className="text-[13px] font-medium">{row.bottle.name}</div>
              <TagLine
                who="Label"
                ids={familyOf(published)}
                toneFor={(id) => ((row.personalFlavorTags[id] ?? 0) > 0 ? "shared" : "blind")}
              />
              <TagLine
                who="You"
                ids={familyOf(row.personalFlavorTags)}
                toneFor={(id) => ((published[id] ?? 0) > 0 ? "shared" : "signature")}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TagLine({
  who,
  ids,
  toneFor,
}: {
  who: string;
  ids: string[];
  toneFor: (id: string) => CalibrationMark;
}) {
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <span className="w-9 shrink-0 pt-1 text-[9px] uppercase tracking-[0.08em] text-muted">{who}</span>
      <span className="flex flex-wrap gap-1.5">
        {ids.length === 0 ? (
          <span className="chip px-2 py-0.5 text-[10px]">—</span>
        ) : (
          ids.map((id) => (
            <span key={id} className={`chip px-2 py-0.5 text-[10px] ${BUCKET_COPY[toneFor(id)].className}`}>
              {leafLabel(id) ?? id}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

function bottleCount(n: number): string {
  return `${n} bottle${n === 1 ? "" : "s"}`;
}

/** One figure in the slim stats strip: a display numeral over an 11px label. */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 flex-1 px-2 py-3 text-center">
      <div className="stat-number truncate text-lg leading-none">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

/**
 * One 40px row: the two collections that matter as a segment, and a single
 * expand carrying everything else with a count. Whatever is active shows as
 * removable tokens on a second line that only exists when it has something on
 * it — including flavors tapped on the wheel, which used to be a parallel
 * filter system with its own clear button buried under the chart.
 */
function FilterBar({
  collection,
  onCollectionChange,
  counts,
  groups,
  checks,
  onToggleCheck,
  flavorIds,
  onRemoveFlavor,
  onClear,
  shownCount,
  totalCount,
}: {
  collection: Collection;
  onCollectionChange: (next: Collection) => void;
  counts: Record<Collection, number>;
  groups: FilterGroup[];
  checks: string[];
  onToggleCheck: (id: string) => void;
  flavorIds: string[];
  onRemoveFlavor: (id: string) => void;
  onClear: () => void;
  shownCount: number;
  totalCount: number;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = checks.length + flavorIds.length;
  const labelOf = (id: string) =>
    groups.flatMap((g) => g.options).find((o) => o.id === id)?.label ?? id;
  const isQuick = QUICK_COLLECTIONS.includes(collection);
  const collectionLabel = COLLECTIONS.find((c) => c.key === collection)?.label ?? collection;

  return (
    <div className="rounded-2xl border border-border-subtle bg-surface">
      <div className="flex items-center justify-between gap-2 p-1.5">
        <span className="px-2.5 text-xs text-muted tabular-nums">
          {shownCount} of {totalCount}
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="bar-filter-panel"
          className={`tap-target inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${
            open ? "text-accent" : "text-muted hover:text-foreground"
          }`}
        >
          <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden /> Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-accent/15 px-1.5 text-[10.5px] text-accent tabular-nums">
              {activeCount}
            </span>
          )}
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {(activeCount > 0 || !isQuick) && (
        // py-2.5 is load-bearing, not spacing: overflow-x-auto forces the other
        // axis to clip too, so without room for the full 44px the tap targets
        // below would be trimmed back to the height of the chips.
        <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-2.5" aria-label="Active filters">
          {!isQuick && (
            <button
              onClick={() => onCollectionChange("own")}
              aria-label={`Remove ${collectionLabel} filter`}
              className="chip tap-target inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11px] text-foreground"
            >
              {collectionLabel} <span aria-hidden className="text-muted">×</span>
            </button>
          )}
          {checks.map((id) => (
            <button
              key={id}
              onClick={() => onToggleCheck(id)}
              aria-label={`Remove ${labelOf(id)} filter`}
              className="chip tap-target inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11px] text-foreground"
            >
              {labelOf(id)} <span aria-hidden className="text-muted">×</span>
            </button>
          ))}
          {flavorIds.map((id) => (
            <button
              key={id}
              onClick={() => onRemoveFlavor(id)}
              aria-label={`Remove ${leafLabel(id) ?? id} filter`}
              className="chip chip-active tap-target inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-[11px]"
            >
              {leafLabel(id) ?? id} <span aria-hidden>×</span>
            </button>
          ))}
          {activeCount > 0 && (
            <button
              onClick={onClear}
              className="tap-target shrink-0 px-2 py-1 text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {open && (
        <div id="bar-filter-panel" className="max-h-[22rem] overflow-y-auto border-t border-border-subtle p-3">
          <div className="mb-3">
            <div className="section-label" id="filter-group-collection">Collection</div>
            <div role="radiogroup" aria-labelledby="filter-group-collection" className="mt-1 grid grid-cols-2 gap-x-3">
              {COLLECTIONS.map((c) => (
                <CheckRow
                  key={c.key}
                  role="radio"
                  checked={collection === c.key}
                  label={`${c.label} (${counts[c.key]})`}
                  onToggle={() => onCollectionChange(c.key)}
                />
              ))}
            </div>
          </div>
          {groups.map((group) => (
            <div key={group.id} className="mb-3">
              <div className="section-label" id={`filter-group-${group.id}`}>{group.label}</div>
              <div role="group" aria-labelledby={`filter-group-${group.id}`} className="mt-1 grid grid-cols-2 gap-x-3">
                {group.options.map((option) => (
                  <CheckRow
                    key={option.id}
                    role="checkbox"
                    checked={checks.includes(option.id)}
                    label={option.label}
                    onToggle={() => onToggleCheck(option.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The whole row is the target, so a 16px box still clears 44px of touch. */
function CheckRow({
  role,
  checked,
  label,
  onToggle,
}: {
  role: "radio" | "checkbox";
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      role={role}
      aria-checked={checked}
      onClick={onToggle}
      className={`flex min-h-11 items-center gap-2.5 text-left text-[13px] ${
        checked ? "text-accent" : "hover:text-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`grid size-4 shrink-0 place-items-center border transition-colors ${
          role === "radio" ? "rounded-full" : "rounded"
        } ${checked ? "border-accent bg-accent" : "border-border-subtle bg-background"}`}
      >
        {checked && <Check size={10} strokeWidth={4} className="text-background" aria-hidden />}
      </span>
      {label}
    </button>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="card p-8 text-center flex flex-col items-center gap-3">
      <div aria-hidden className="text-4xl">
        🔍
      </div>
      <p className="font-display text-lg font-semibold">Nothing matches</p>
      <p className="text-sm text-muted max-w-[26ch] leading-relaxed">
        There are bottles here — these filters are just too narrow for them.
      </p>
      <button onClick={onClear} className="btn-secondary px-5 py-2.5 text-sm font-medium mt-1">
        Clear filters
      </button>
    </div>
  );
}

function EmptyState({ collection }: { collection: Collection }) {
  const copy =
    collection === "own"
      ? {
          title: "Your shelf is waiting",
          line: "Find a bottle you love and add it to your bar.",
          action: "Find a bottle",
        }
      : collection === "wishlist"
        ? {
            title: "Nothing wished for yet",
            line: "Save bottles you're hunting and track their going price.",
            action: "Browse bottles",
          }
        : collection === "all"
          ? {
              title: "Nothing here yet",
              line: "Bottles you own and bottles you’ve only tasted both land here.",
              action: "Find a bottle",
            }
          : {
            title: "No tastings logged",
            line: "Bottles you've tried — at a bar, a friend's, a festival — live here.",
            action: "Find a bottle",
          };
  return (
    <div className="card p-8 text-center flex flex-col items-center gap-3">
      <div aria-hidden className="text-4xl">
        🥃
      </div>
      <p className="font-display text-lg font-semibold">{copy.title}</p>
      <p className="text-sm text-muted max-w-[26ch] leading-relaxed">{copy.line}</p>
      {collection === "own" ? (
        <>
          <Link href="/scan" className="btn-primary px-5 py-2.5 text-sm font-medium mt-1">
            Scan your bottles
          </Link>
          <Link href="/search" className="btn-secondary px-5 py-2.5 text-sm font-medium">
            {copy.action}
          </Link>
          <Link href="/import" className="text-sm text-muted hover:text-foreground transition-colors">
            or import a spreadsheet / app export
          </Link>
          <Link
            href="/welcome"
            className="text-xs text-muted/80 hover:text-foreground transition-colors"
          >
            New here? Take the tour
          </Link>
        </>
      ) : (
        <Link href="/search" className="btn-secondary px-5 py-2.5 text-sm font-medium mt-1">
          {copy.action}
        </Link>
      )}
    </div>
  );
}
