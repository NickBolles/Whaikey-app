"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { GlassWater, Plus } from "lucide-react";
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
import { FillGauge } from "@/components/fill-gauge";
import { FlavorHeatLegend } from "@/components/flavor-wheel";
import { RecommendationRail } from "@/components/recommendation-rail";
import { FlavorRadar } from "@/components/flavor-radar";

/** BarRow with dates possibly serialized to strings (API JSON responses). */
export type Row = Omit<BarRow, "createdAt" | "updatedAt" | "purchaseDate"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  purchaseDate: Date | string | null;
};

type Tab = "bar" | "wishlist" | "tried";

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

const TABS: { key: Tab; label: string }[] = [
  { key: "bar", label: "My Bar" },
  { key: "wishlist", label: "Wishlist" },
  { key: "tried", label: "Tried" },
];

// Labels stay distinct from the section tabs above them: two rows of chips
// reading "Tried" would be ambiguous on screen and to a screen reader.
const SCOPES: { key: FlavorHeatScope; label: string; blurb: string }[] = [
  { key: "own", label: "On my shelf", blurb: "the bottles you own" },
  { key: "tried", label: "Only tasted", blurb: "bottles you’ve tasted but don’t own" },
  { key: "all", label: "Everything", blurb: "every bottle you’ve owned or tasted" },
];

/** The scope a tab opens on: each tab starts by describing its own rows. */
const DEFAULT_SCOPE_FOR_TAB: Record<Tab, FlavorHeatScope> = {
  bar: "own",
  tried: "tried",
  wishlist: "own",
};

const FILL_STEPS = [100, 75, 50, 25, 10];

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function statusChipClass(status: string | null): string {
  switch (status) {
    case "open":
      return "chip-active";
    case "finished":
      return "line-through opacity-70";
    default:
      return "";
  }
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
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [tab, setTab] = useState<Tab>("bar");
  const [lens, setLens] = useState<Lens>("mine");
  const [weightByRating, setWeightByRating] = useState(false);
  const [flavorScope, setFlavorScope] = useState<FlavorHeatScope>("own");
  const [selectedFlavorIds, setSelectedFlavorIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  function fail(message: string) {
    setError(message);
    setTimeout(() => setError(null), 4000);
  }

  async function patchRow(id: string, patch: Record<string, unknown>) {
    const prev = rows;
    // Optimistic: mirror the server's fill-level rules locally.
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch } as Row;
        if (patch.status === "finished") next.fillLevel = 0;
        else if (
          patch.status === "open" &&
          patch.fillLevel === undefined &&
          (r.status === "sealed" || r.status == null)
        )
          next.fillLevel = 100;
        return next;
      }),
    );
    const res = await fetch(`/api/user-bottles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    if (!res?.ok) {
      setRows(prev);
      fail("Update failed — try again.");
      return;
    }
    const updated = (await res.json()) as Partial<Row>;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...updated, bottle: r.bottle } : r)));
  }

  async function removeRow(id: string) {
    const prev = rows;
    setRows((rs) => rs.filter((r) => r.id !== id));
    setExpandedId(null);
    const res = await fetch(`/api/user-bottles/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setRows(prev);
      fail("Remove failed — try again.");
    }
  }

  async function moveToBar(row: Row) {
    const answer = window.prompt("What did you pay for it? (optional, e.g. 59.99)", "");
    if (answer === null) return;
    const price = answer.trim() === "" ? undefined : Number.parseFloat(answer);
    const body: Record<string, unknown> = { bottleId: row.bottleId, relationship: "own" };
    if (price != null && Number.isFinite(price) && price >= 0) {
      body.purchasePrice = price;
      body.purchaseDate = new Date().toISOString();
    }
    const res = await fetch("/api/user-bottles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      fail("Could not move to bar — try again.");
      return;
    }
    const updated = (await res.json()) as Partial<Row>;
    setRows((rs) =>
      rs.map((r) =>
        r.id === row.id
          ? { ...r, ...updated, relationship: "own", status: r.status ?? "sealed", bottle: r.bottle }
          : r,
      ),
    );
    setTab("bar");
  }

  const activeRows = tab === "bar" ? ownRows : tab === "wishlist" ? wishlistRows : triedRows;
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
  const effectiveLens: Lens =
    (lens === "label" && !hasPublishedNotes) || (lens === "compare" && !canCompare) ? "mine" : lens;
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
  const flavorFilterable = tab !== "wishlist";
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

  function changeFlavorScope(scope: FlavorHeatScope) {
    setFlavorScope(scope);
    setSelectedFlavorIds([]);
  }

  // Each tab opens describing its own shelf; an explicit scope choice is only
  // reset by moving to a tab whose rows it no longer matches.
  function changeTab(next: Tab) {
    setTab(next);
    setFlavorScope((current) =>
      current === "all" ? current : DEFAULT_SCOPE_FOR_TAB[next],
    );
    setSelectedFlavorIds([]);
  }

  function toggleFlavor(selection: FlavorSelection) {
    setSelectedFlavorIds((current) => {
      const allSelected = selection.leafIds.every((id) => current.includes(id));
      return allSelected
        ? current.filter((id) => !selection.leafIds.includes(id))
        : Array.from(new Set([...current, ...selection.leafIds]));
    });
  }

  return (
    <div className="px-4 pt-5 pb-10 flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <h1 className="font-display text-[2rem] leading-tight font-semibold">My Bar</h1>
        <Link
          href="/search"
          className="inline-flex items-center gap-1 min-h-11 px-1 text-sm font-medium text-accent hover:underline"
        >
          <Plus size={16} strokeWidth={1.8} aria-hidden /> Add bottle
        </Link>
      </header>

      <div role="tablist" aria-label="Bar sections" className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => changeTab(t.key)}
            className={`chip inline-flex items-center min-h-11 px-4 text-sm font-medium ${
              tab === t.key ? "chip-active" : "hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger text-sm p-3">
          {error}
        </div>
      )}

      {tab === "bar" && (
        <section aria-label="Bar stats" className="grid grid-cols-4 gap-2">
          <StatCard value={String(stats.bottleCount)} label="bottles" />
          <StatCard value={String(stats.openCount)} label="open" />
          <StatCard value={money(stats.totalSpent)} label="spent" />
          <StatCard value={money(stats.estValue)} label="est. value" />
        </section>
      )}

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
          onScopeChange={changeFlavorScope}
          selectedFlavorIds={selectedFlavorIds}
          onToggleFlavor={toggleFlavor}
          onClearFlavors={() => setSelectedFlavorIds([])}
          shownCount={filteredRows.length}
          totalCount={activeRows.length}
          rowNoun={tab === "bar" ? "bottles" : "tastings"}
          topWedgeIds={palate.topWedgeIds}
        />
      )}

      {tab === "bar" && (
        <>
          <RecommendationRail mode="tonight" title="What to pour tonight" />
          <RecommendationRail mode="discovery" title="For your palate" />
        </>
      )}

      {filteredRows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {filteredRows.map((row) => (
            <li key={row.id} className="card-flat overflow-hidden">
              {tab === "bar" ? (
                <>
                  <button
                    className="w-full flex items-center gap-3.5 p-4 text-left hover:bg-surface-raised transition-colors"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    aria-expanded={expandedId === row.id}
                  >
                    <FillGauge level={row.fillLevel} className="h-12 w-5 shrink-0 text-muted" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium leading-snug line-clamp-2">
                        {row.bottle.name}
                      </span>
                      <span className="block text-xs text-muted truncate mt-0.5">
                        {row.bottle.distilleryName ?? row.bottle.category}
                        {row.quantity > 1 ? ` · ×${row.quantity}` : ""}
                      </span>
                      {row.notes && (
                        <span className="block text-xs text-foreground/60 font-display italic truncate mt-1">
                          “{row.notes}”
                        </span>
                      )}
                    </span>
                    <span className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={`stat-number text-lg leading-none ${row.purchasePrice != null ? "" : "text-muted"}`}>{row.purchasePrice != null ? `$${row.purchasePrice.toFixed(0)}` : "—"}</span>
                      {row.status && <span className={`chip px-2 py-0.5 text-[10px] font-medium ${statusChipClass(row.status)}`}>{row.status}</span>}
                    </span>
                  </button>
                  <div className="flex justify-end border-t border-border-subtle px-3 py-2"><Link href={`/pour?bottleId=${row.bottleId}`} className="inline-flex min-h-9 items-center gap-1.5 px-2 text-xs font-medium text-accent hover:underline"><GlassWater size={14} aria-hidden /> Log this pour</Link></div>
                  {expandedId === row.id && (
                    <RowDetails
                      key={row.id}
                      row={row}
                      onPatch={(patch) => patchRow(row.id, patch)}
                      onRemove={() => removeRow(row.id)}
                    />
                  )}
                </>
              ) : (
                <div className="flex items-center gap-3.5 p-4">
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium leading-snug line-clamp-2">
                      {row.bottle.name}
                    </span>
                    <span className="block text-xs text-muted truncate mt-0.5">
                      {row.bottle.distilleryName ?? row.bottle.category}
                    </span>
                  </span>
                  {tab === "wishlist" ? (
                    <span className="flex flex-col items-end gap-1.5 shrink-0">
                      {row.bottle.avgPrice != null && (
                        <span className="text-muted text-sm">
                          ~<span className="stat-number">${row.bottle.avgPrice.toFixed(0)}</span>
                        </span>
                      )}
                      <button
                        onClick={() => moveToBar(row)}
                        className="btn-primary text-[13px] px-3.5 py-2"
                      >
                        Move to bar
                      </button>
                    </span>
                  ) : (
                    <span className="chip px-2.5 py-1 text-[11px] capitalize shrink-0">
                      {row.bottle.category}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
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
  onScopeChange,
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
  onScopeChange: (scope: FlavorHeatScope) => void;
  selectedFlavorIds: string[];
  onToggleFlavor: (selection: FlavorSelection) => void;
  onClearFlavors: () => void;
  shownCount: number;
  totalCount: number;
  rowNoun: string;
  topWedgeIds: string[];
}) {
  const scopeMeta = SCOPES.find((s) => s.key === scope) ?? SCOPES[0];
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
                className={`inline-flex min-h-9 items-center rounded-full px-3 text-xs font-medium transition-colors ${
                  lens === l.key ? "chip-active" : "text-muted hover:text-foreground"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Weighted by rating the wheel describes the drinker, not a shelf, so
          the scope it would filter no longer applies. */}
      {!isPalate && (
      <div role="tablist" aria-label="Flavor map scope" className="mt-2 flex flex-wrap gap-2">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={scope === s.key}
            onClick={() => onScopeChange(s.key)}
            className={`chip inline-flex min-h-11 items-center px-3 text-xs font-medium ${
              scope === s.key ? "chip-active" : "text-muted hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      )}

      {/* Full width, under the toggles: squeezed beside them it wrapped to a
          four-line column on a phone. */}
      <p className="mt-2 mb-3 text-xs text-muted">
        {isCompare
          ? "Your tagged notes read against the published ones. The label is one opinion, not an answer key."
          : isPalate
            ? "Where your ratings lean, weighted by how recently you poured; tagged notes refine its details."
            : lens === "label"
              ? `What the distilleries claim about ${scopeMeta.blurb}.`
              : `The wheel maps ${scopeMeta.blurb}; tagged notes refine its details.`}
      </p>

      {/* Outside the card on purpose: with no tagged notes yet the card falls
          back to an empty state, and the drinker still needs a way to reach the
          rating-weighted view that may well have signal. */}
      {lens === "mine" && (
        <button
          onClick={() => onWeightChange(!weightByRating)}
          aria-pressed={weightByRating}
          className={`chip mb-3 inline-flex min-h-9 items-center px-3 text-[11px] font-medium ${
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
                ? `Log a pour and tag what you taste to map ${scopeMeta.blurb}.`
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
      ? substitute
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

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="card p-3">
      <div className="stat-number text-[1.35rem] leading-none text-accent">{value}</div>
      <div className="text-[10px] text-muted mt-2">{label}</div>
    </div>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  const copy =
    tab === "bar"
      ? {
          title: "Your shelf is waiting",
          line: "Find a bottle you love and add it to your bar.",
          action: "Find a bottle",
        }
      : tab === "wishlist"
        ? {
            title: "Nothing wished for yet",
            line: "Save bottles you're hunting and track their going price.",
            action: "Browse bottles",
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
      {tab === "bar" ? (
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
        </>
      ) : (
        <Link href="/search" className="btn-secondary px-5 py-2.5 text-sm font-medium mt-1">
          {copy.action}
        </Link>
      )}
    </div>
  );
}

function RowDetails({
  row,
  onPatch,
  onRemove,
}: {
  row: Row;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [price, setPrice] = useState(row.purchasePrice?.toString() ?? "");
  const [store, setStore] = useState(row.store ?? "");
  const [location, setLocation] = useState(row.location ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");

  function saveDetails() {
    const parsed = price.trim() === "" ? null : Number.parseFloat(price);
    onPatch({
      purchasePrice: parsed != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
      store: store.trim() === "" ? null : store.trim(),
      location: location.trim() === "" ? null : location.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  }

  const hasProfile =
    row.bottle.flavorProfile != null && Object.keys(row.bottle.flavorProfile).length > 0;

  const inputClass =
    "rounded-xl bg-surface-raised/70 border border-border-subtle px-3 py-2.5 text-sm w-full";

  return (
    <div className="border-t border-border-subtle p-4 flex flex-col gap-4 bg-surface-raised/30">
      <div className="flex flex-wrap items-center gap-2">
        {row.status !== "open" && row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "open" })}
            className="btn-secondary min-h-11 px-4 text-sm font-medium"
          >
            Mark open
          </button>
        )}
        {row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "finished" })}
            className="btn-secondary min-h-11 px-4 text-sm font-medium"
          >
            Mark finished
          </button>
        )}
        <button
          onClick={onRemove}
          className="ml-auto min-h-11 px-2 text-sm text-danger hover:underline"
        >
          Remove
        </button>
      </div>

      {hasProfile && (
        <div>
          <div className="section-label mb-2">Flavor profile</div>
          <div className="flex justify-center">
            <FlavorRadar profile={row.bottle.flavorProfile} size={230} />
          </div>
        </div>
      )}

      {row.status === "open" && (
        <div>
          <div className="section-label mb-2">
            Fill level{row.fillLevel != null ? ` · ${row.fillLevel}%` : ""}
          </div>
          <div className="flex flex-wrap gap-2">
            {FILL_STEPS.map((step) => (
              <button
                key={step}
                onClick={() => onPatch({ fillLevel: step })}
                aria-pressed={row.fillLevel === step}
                className={`chip inline-flex items-center min-h-11 px-3.5 text-[13px] font-medium ${
                  row.fillLevel === step ? "chip-active" : "hover:text-foreground"
                }`}
              >
                {step}%
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 items-end">
        <label className="text-xs text-muted flex flex-col gap-1.5">
          Paid ($)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className={inputClass}
            placeholder="59.99"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1.5">
          Store
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className={inputClass}
            placeholder="Store"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1.5">
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className={inputClass}
            placeholder="Shelf A"
          />
        </label>
      </div>

      <label className="text-xs text-muted flex flex-col gap-1.5">
        Your notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={`${inputClass} resize-y min-h-[44px]`}
          placeholder="Great with a drop of water…"
        />
      </label>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={saveDetails}
          className="btn-secondary min-h-11 px-4 text-sm font-medium"
        >
          Save details
        </button>
        <Link
          href={`/bottles/${row.bottleId}`}
          className="min-h-11 inline-flex items-center text-sm font-medium text-accent hover:underline"
        >
          Bottle &amp; tasting notes →
        </Link>
      </div>
    </div>
  );
}
