/**
 * The pour sheet's draft (docs/STORYBOARD.md Q2: "kept, for 24 h; one draft
 * at a time"). Notes can be started before a bottle is chosen (D4), so closing
 * the sheet must not lose them. Stored per account on this device only —
 * a draft is never sent anywhere until Save.
 */

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = "whaikey:pour-draft:v1:";

export interface PourDraft {
  bottle: { id: string; name: string; distillery?: string | null; category?: string | null } | null;
  rating: number | null;
  servingStyle: string | null;
  amountMl: number;
  freeform: string;
  nose: string;
  palate: string;
  finish: string;
  flavorTags: Record<string, number>;
  companions: string;
  savedAt: number;
}

export type DraftContent = Omit<PourDraft, "savedAt">;

/** A draft worth keeping: anything the user typed, tapped or picked. */
export function hasDraftContent(d: Partial<DraftContent>): boolean {
  return Boolean(
    d.bottle ||
      d.rating != null ||
      d.servingStyle ||
      d.freeform?.trim() ||
      d.nose?.trim() ||
      d.palate?.trim() ||
      d.finish?.trim() ||
      d.companions?.trim() ||
      (d.flavorTags && Object.keys(d.flavorTags).length > 0),
  );
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function key(userId: string | undefined): string {
  return `${KEY_PREFIX}${userId ?? "anon"}`;
}

export function loadDraft(userId: string | undefined, now = Date.now()): PourDraft | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key(userId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as PourDraft;
    if (typeof draft?.savedAt !== "number" || now - draft.savedAt > DRAFT_TTL_MS) {
      s.removeItem(key(userId));
      return null;
    }
    return hasDraftContent(draft) ? draft : null;
  } catch {
    return null;
  }
}

export function saveDraft(userId: string | undefined, content: DraftContent, now = Date.now()): void {
  const s = storage();
  if (!s) return;
  try {
    if (!hasDraftContent(content)) {
      s.removeItem(key(userId));
      return;
    }
    s.setItem(key(userId), JSON.stringify({ ...content, savedAt: now } satisfies PourDraft));
  } catch {
    // Storage full or blocked: the draft is a convenience, never a blocker.
  }
}

export function clearDraft(userId: string | undefined): void {
  try {
    storage()?.removeItem(key(userId));
  } catch {
    // As above.
  }
}
