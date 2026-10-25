import { createHmac, timingSafeEqual } from "node:crypto";

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

export function signCard(kind: CardKind, subject: string, extra = ""): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`whaikey.card.v1:${kind}:${subject}:${extra}`).digest("base64url").slice(0, 32);
}

export function verifyCard(kind: CardKind, subject: string, extra: string, sig: string | null): boolean {
  const expected = signCard(kind, subject, extra);
  if (!expected || !sig || sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function cardPath(kind: CardKind, subject: string, extra: string, format: CardFormat): string | null {
  const sig = signCard(kind, subject, extra);
  if (!sig) return null;
  const q = new URLSearchParams({ s: subject, f: format, sig, ...(extra ? { x: extra } : {}) });
  return `/api/cards/${kind}?${q.toString()}`;
}
