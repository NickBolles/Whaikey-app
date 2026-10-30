import type { OutingBoardBottle } from "@/lib/outings";

/** Something someone else did on the outing since the last render. */
export interface OutingArrival {
  /** Board key of the bottle it happened on. */
  key: string;
  kind: "bottle" | "rating";
  message: string;
}

/**
 * Pure: what other people added between two renders of the board, for the
 * "Sam added Lagavulin 16" toast and the arrival highlight. The viewer's own
 * writes are skipped (they already got their own confirmation), and nothing
 * here mentions amounts, pours or who is drinking now — only bottles on the
 * list and ratings.
 */
export function boardArrivals(prev: OutingBoardBottle[], next: OutingBoardBottle[]): OutingArrival[] {
  const before = new Map(prev.map((b) => [b.key, b]));
  const out: OutingArrival[] = [];
  for (const b of next) {
    const old = before.get(b.key);
    if (!old) {
      if (b.addedBy && !b.addedByMe) out.push({ key: b.key, kind: "bottle", message: `${b.addedBy} added ${b.label}` });
      else if (!b.addedBy) {
        const v = b.votes.find((x) => !x.mine);
        if (v) out.push({ key: b.key, kind: "rating", message: `${v.who} rated ${b.label}` });
      }
      continue;
    }
    const had = new Map(old.votes.map((v) => [v.who, v]));
    for (const v of b.votes) {
      if (v.mine) continue;
      const was = had.get(v.who);
      if (!was) out.push({ key: b.key, kind: "rating", message: `${v.who} rated ${b.label}` });
      else if (was.rating !== v.rating || was.note !== v.note || was.tags.join() !== v.tags.join())
        out.push({ key: b.key, kind: "rating", message: `${v.who} updated their notes on ${b.label}` });
    }
  }
  return out;
}

/** One line for the toast: the first arrival, plus "and N more" when several land together. */
export function arrivalToast(arrivals: OutingArrival[]): string | null {
  if (arrivals.length === 0) return null;
  if (arrivals.length === 1) return arrivals[0].message;
  return `${arrivals[0].message}, and ${arrivals.length - 1} more`;
}
