import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { shareCardKeys } from "@/db/schema";

/**
 * Share-out cards (docs/SOCIAL.md §7.10; design board P3: 1080×1920 story +
 * 1200×630 link card). A card URL is a bearer link the subject mints for
 * themselves: an HMAC over (kind, subject, extra) under `BETTER_AUTH_SECRET`,
 * so a link preview crawler can fetch it without a session, and nobody can
 * mint one for somebody else. The image is rendered from live data, so a card
 * for a deleted account or a withdrawn flight stops rendering.
 */
export const CARD_KINDS = ["passport", "palate", "wrapped", "flight"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_FORMATS = { story: { width: 1080, height: 1920 }, link: { width: 1200, height: 630 } } as const;
export type CardFormat = keyof typeof CARD_FORMATS;

function secret(): string | null {
  return process.env.BETTER_AUTH_SECRET || null;
}

export function signCard(kind: CardKind, subject: string, extra = "", epoch = 0): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`whaikey.card.v1:${kind}:${subject}:${extra}:${epoch}`).digest("base64url").slice(0, 32);
}

export function verifyCard(kind: CardKind, subject: string, extra: string, sig: string | null, epoch = 0): boolean {
  const expected = signCard(kind, subject, extra, epoch);
  if (!expected || !sig || sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function cardPath(kind: CardKind, subject: string, extra: string, format: CardFormat, epoch = 0): string | null {
  const sig = signCard(kind, subject, extra, epoch);
  if (!sig) return null;
  const q = new URLSearchParams({ s: subject, f: format, sig, ...(extra ? { x: extra } : {}) });
  return `/api/cards/${kind}?${q.toString()}`;
}

/** The card owner's current key epoch (0 until they first revoke). */
export async function cardEpoch(db: DB, userId: string): Promise<number> {
  const row = await db.query.shareCardKeys.findFirst({ where: eq(shareCardKeys.userId, userId) });
  return row?.epoch ?? 0;
}

/** Revoke every card link this person has shared, for good. */
export async function revokeAllCards(db: Pick<DB, "insert">, userId: string): Promise<void> {
  await db
    .insert(shareCardKeys)
    .values({ userId, epoch: 1, rotatedAt: new Date() })
    .onConflictDoUpdate({ target: shareCardKeys.userId, set: { epoch: sql`${shareCardKeys.epoch} + 1`, rotatedAt: new Date() } });
}

/** Whose epoch signs a card: the subject for personal cards, the sharing taster for flight results. */
export const cardOwner = (kind: CardKind, subject: string, extra: string) => (kind === "flight" ? extra : subject);
