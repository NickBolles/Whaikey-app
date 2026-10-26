"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Star, Trash2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { PourShareButton } from "@/components/pour-share-button";
import { VisibilityControl } from "@/components/visibility-control";
import { SERVING_STYLES, type PourVisibility } from "@/db/schema";
import { StarRating } from "@/components/star-rating";
import { VisibilityChips } from "@/components/visibility-chips";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { IntensityDots } from "@/components/flavor-chip";

/** Serialized pour crossing the server→client boundary (timestamp as ISO). */
export interface TimelinePour {
  id: string;
  bottleId: string;
  bottleName: string;
  rating: number | null;
  servingStyle: string | null;
  amountMl: number | null;
  createdAt: string;
  visibility: PourVisibility;
  /** ISO time of the owner's last edit of the entry, or null. */
  editedAt?: string | null;
  note: {
    nose: string | null;
    palate: string | null;
    finish: string | null;
    freeform: string | null;
    flavorTags: Record<string, number> | null;
  } | null;
}

/** Nudge a wedge hue toward the warm brass palette (kept in sync with FlavorWheelInput). */
function warmify(hex: string): string {
  const warm = [185, 141, 79]; // brass midpoint (#b98d4f)
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * 0.78 + warm[i] * 0.22));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, warmify(w.color)]));

function noteSnippet(note: TimelinePour["note"]): string | null {
  if (!note) return null;
  const text = note.nose ?? note.palate ?? note.finish ?? note.freeform;
  if (!text) return null;
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}

function dayKey(date: Date, now: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

type EntryEdit = {
  rating?: number | null;
  servingStyle?: string | null;
  visibility?: PourVisibility;
  note?: Partial<Record<"nose" | "palate" | "finish" | "freeform", string | null>> & {
    flavorTags?: Record<string, number> | null;
  };
};

type EditResponse = {
  pour: { rating: number | null; servingStyle: string | null; visibility: PourVisibility; editedAt: string | null };
  note: TimelinePour["note"];
  previous: EntryEdit;
};

async function patchEntry(pourId: string, edit: EntryEdit): Promise<EditResponse> {
  const res = await fetch(`/api/pours/${encodeURIComponent(pourId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edit),
  });
  const body = (await res.json().catch(() => null)) as (EditResponse & { message?: string }) | null;
  if (!res.ok || !body?.pour) throw new Error(body?.message ?? "");
  return body;
}

const NOTE_LABELS = [
  ["nose", "Nose"],
  ["palate", "Palate"],
  ["finish", "Finish"],
] as const;

/**
 * Inline edit of one journal entry: rating, serving, note text, visibility.
 * Saves only what changed; the parent shows the Undo toast.
 */
function EntryEditor({
  pour,
  onSaved,
  onCancel,
}: {
  pour: TimelinePour;
  onSaved: (res: EditResponse) => void;
  onCancel: () => void;
}) {
  const [rating, setRating] = useState<number | null>(pour.rating);
  const [serving, setServing] = useState<string | null>(pour.servingStyle);
  const [visibility, setVisibility] = useState<PourVisibility>(pour.visibility);
  const [fields, setFields] = useState({
    nose: pour.note?.nose ?? "",
    palate: pour.note?.palate ?? "",
    finish: pour.note?.finish ?? "",
    freeform: pour.note?.freeform ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownStructured = NOTE_LABELS.filter(([key]) => Boolean(pour.note?.[key]));

  async function save() {
    const edit: EntryEdit = {};
    if (rating !== pour.rating) edit.rating = rating;
    if (serving !== pour.servingStyle) edit.servingStyle = serving;
    if (visibility !== pour.visibility) edit.visibility = visibility;
    const note: NonNullable<EntryEdit["note"]> = {};
    for (const key of ["nose", "palate", "finish", "freeform"] as const) {
      const next = fields[key].trim() || null;
      if (next !== (pour.note?.[key] ?? null)) note[key] = next;
    }
    if (Object.keys(note).length > 0) edit.note = note;
    if (Object.keys(edit).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await patchEntry(pour.id, edit));
    } catch (err) {
      setError((err as Error).message || "Couldn't save that edit. Try again.");
      setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={`Edit pour of ${pour.bottleName}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <StarRating value={rating} onChange={setRating} />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Serving">
        {SERVING_STYLES.map((style) => (
          <button
            key={style}
            type="button"
            aria-pressed={serving === style}
            onClick={() => setServing(serving === style ? null : style)}
            className={`chip min-h-11 px-3 text-sm capitalize ${serving === style ? "chip-active font-medium" : "hover:bg-surface-raised"}`}
          >
            {style}
          </button>
        ))}
      </div>
      {shownStructured.map(([key, label]) => (
        <label key={key} className="flex flex-col gap-1 text-xs text-muted">
          {label}
          <textarea
            value={fields[key]}
            maxLength={2000}
            rows={2}
            onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
            className="resize-y rounded-lg border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>
      ))}
      <label className="flex flex-col gap-1 text-xs text-muted">
        Notes
        <textarea
          value={fields.freeform}
          maxLength={5000}
          rows={3}
          onChange={(e) => setFields((f) => ({ ...f, freeform: e.target.value }))}
          className="resize-y rounded-lg border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </label>
      <VisibilityChips value={visibility} onChange={setVisibility} idPrefix={`edit-vis-${pour.id}`} />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-60">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary min-h-11 px-4 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

function PourRow({ pour: initial }: { pour: TimelinePour }) {
  const router = useRouter();
  const toast = useToast();
  const [pour, setPour] = useState<TimelinePour>(initial);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const visibility = pour.visibility;
  const setVisibility = (next: PourVisibility) => setPour((p) => ({ ...p, visibility: next }));

  function applyResponse(res: EditResponse) {
    setPour((p) => ({
      ...p,
      rating: res.pour.rating,
      servingStyle: res.pour.servingStyle,
      visibility: res.pour.visibility,
      editedAt: res.pour.editedAt,
      note: res.note,
    }));
  }

  /**
   * An edit commits at once (it is reversible, unlike a delete) and the toast
   * carries Undo, which PATCHes back the server's own record of what the
   * fields were — not the client's guess.
   */
  function saved(res: EditResponse) {
    applyResponse(res);
    setEditing(false);
    setMenuOpen(false);
    toast.show({
      message: `Updated your pour of ${pour.bottleName}`,
      undo: async () => {
        try {
          applyResponse(await patchEntry(pour.id, res.previous));
          router.refresh();
        } catch (err) {
          toast.error(`Couldn't undo that edit of ${pour.bottleName}.`);
          throw err;
        }
      },
    });
    router.refresh();
  }
  const snippet = noteSnippet(pour.note);
  const tags = pour.note?.flavorTags ? Object.entries(pour.note.flavorTags) : [];
  const shownTags = tags.slice(0, 3);
  const time = new Date(pour.createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const menuId = `pour-menu-${pour.id}`;

  /**
   * Delete is a deferred commit (STORYBOARD §1.2): the row leaves at once, the
   * DELETE only goes out when the toast closes without Undo.
   */
  function remove() {
    setMenuOpen(false);
    setHidden(true);
    toast.show({
      message: `Deleted a pour of ${pour.bottleName}`,
      undo: () => setHidden(false),
      onClose: (reason) => {
        if (reason === "undone") return;
        void fetch(`/api/pours/${encodeURIComponent(pour.id)}`, { method: "DELETE" })
          .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            router.refresh();
          })
          .catch(() => {
            setHidden(false);
            toast.error(`Couldn't delete that pour of ${pour.bottleName}. Try again.`);
          });
      },
    });
  }

  if (hidden) return null;
  return (
    <li className="py-2" data-testid="journal-row">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <Link href={`/bottles/${pour.bottleId}`} className="truncate text-sm font-semibold hover:text-accent transition-colors">
              {pour.bottleName}
            </Link>
            {pour.rating != null && (
              <span className="flex shrink-0 items-center gap-1 text-accent">
                <Star size={12} fill="currentColor" aria-hidden />
                <span className="stat-number text-[15px] leading-none tabular-nums">{pour.rating.toFixed(1)}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {[pour.servingStyle, pour.amountMl != null ? `${pour.amountMl} ml` : null, time, VISIBILITY_WORD[visibility], pour.editedAt ? "edited" : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {snippet && <p className="mt-1 line-clamp-2 text-xs italic text-foreground/75">{snippet}</p>}
          {shownTags.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-1" aria-label="Flavor tags">
              {shownTags.map(([leafId, intensity]) => (
                <li key={leafId} className="chip flex items-center gap-1 px-2 py-0.5 text-xs">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: wedgeColor.get(wedgeForLeaf(leafId) ?? "") ?? "var(--muted)" }}
                    aria-hidden
                  />
                  <span className="text-foreground/90">{leafLabel(leafId) ?? leafId}</span>
                  <IntensityDots intensity={intensity} className="text-accent" />
                </li>
              ))}
              {tags.length > 3 && <li className="px-1 py-0.5 text-xs text-muted">+{tags.length - 3}</li>}
            </ul>
          )}
        </div>
        <button
          type="button"
          aria-label={`More for ${pour.bottleName}`}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((o) => !o)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground"
        >
          <MoreHorizontal size={18} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
      {/* Row ⋯ (STORYBOARD D9): sharing and visibility moved in here so a row
          is one line of identity plus one of meta, not a stack of controls. */}
      <div id={menuId} hidden={!menuOpen} className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface p-2.5">
        {editing ? (
          <EntryEditor pour={pour} onSaved={saved} onCancel={() => setEditing(false)} />
        ) : (
        <>
        <VisibilityControl key={visibility} pourId={pour.id} visibility={visibility} onChange={setVisibility} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="btn-secondary flex min-h-11 items-center gap-1.5 px-3 text-sm">
            <Pencil size={14} strokeWidth={1.8} aria-hidden /> Edit
          </button>
          <PourShareButton pourId={pour.id} bottleName={pour.bottleName} />
          <Link href={`/history?bottleId=${encodeURIComponent(pour.bottleId)}`} className="btn-secondary flex min-h-11 items-center px-3 text-sm">
            All pours of this bottle
          </Link>
          <button type="button" onClick={remove} className="btn-secondary flex min-h-11 items-center gap-1.5 px-3 text-sm text-danger">
            <Trash2 size={14} strokeWidth={1.8} aria-hidden /> Delete
          </button>
        </div>
        </>
        )}
      </div>
    </li>
  );
}

const VISIBILITY_WORD: Record<PourVisibility, string> = {
  private: "only me",
  friends: "shared with friends",
  followers: "followers",
  public: "public",
};

/**
 * Groups pours into day sections and formats times in the viewer's timezone.
 * Grouping is TZ-dependent (a late-night pour can land on a different calendar
 * day per zone), so it must run on the client — the server has no idea where
 * the viewer is. We render the flat, TZ-free row list on first paint (matching
 * SSR) and swap in day-grouped headers once mounted, avoiding a hydration
 * mismatch without a loading flash.
 */
const emptySubscribe = () => () => {};

/** False during SSR and the first client render, true once hydrated. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export function HistoryTimeline({ pours }: { pours: TimelinePour[] }) {
  const mounted = useHydrated();

  const groups = useMemo(() => {
    const now = new Date();
    const out: Array<{ day: string; pours: TimelinePour[] }> = [];
    for (const pour of pours) {
      const day = dayKey(new Date(pour.createdAt), now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.pours.push(pour);
      else out.push({ day, pours: [pour] });
    }
    return out;
  }, [pours]);

  if (!mounted) {
    // First paint: no day headers (their labels are timezone-dependent), just
    // the rows in order. Deterministic and identical on server and client.
    return (
      <ul className="ledger flex flex-col">
        {pours.map((pour) => (
          <PourRow key={pour.id} pour={pour} />
        ))}
      </ul>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.day} aria-label={group.day}>
          <h2 className="section-label mb-1 border-b border-border pb-1">{group.day}</h2>
          <ul className="ledger flex flex-col">
            {group.pours.map((pour) => (
              <PourRow key={pour.id} pour={pour} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
