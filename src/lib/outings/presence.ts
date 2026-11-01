/**
 * Who's on an outing, and who has it open in the app right now.
 *
 * Presence is deliberately thin: one `last_seen_at` per seat, bumped by a
 * heartbeat from the outing page while it is visible. It says only "has this
 * page open" — never anything about pours, amounts or what anyone is having.
 * Visible only to people on that outing.
 */

/** A heartbeat every ~45 s; someone counts as "here now" for 2 minutes after. */
export const PRESENCE_HEARTBEAT_MS = 45_000;
export const PRESENCE_WINDOW_MS = 120_000;

/** Pure: is a seat "here now" given its last heartbeat? */
export function isHereNow(lastSeenAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const t = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  // A small allowance for clock skew between app servers; anything far in the future is ignored.
  return age <= PRESENCE_WINDOW_MS && age >= -30_000;
}

/** The friend button on a member row: Add / Requested / Friends / Following / You, or none for guests. */
export type MemberFriendState = "you" | "friends" | "following" | "requested" | "add" | "none";

/**
 * Pure: the friend-button state for one member. `outgoing` is the viewer's
 * follow row to them, `incoming` theirs to the viewer. Friends = mutual
 * accepted follows (docs/SOCIAL.md D1). Guests (no account or no handle) and
 * signed-out viewers get no button.
 */
export function memberFriendState(input: {
  isSelf: boolean;
  hasAccount: boolean;
  handle: string | null;
  viewerSignedIn: boolean;
  outgoing: "pending" | "accepted" | null;
  incoming: "pending" | "accepted" | null;
}): MemberFriendState {
  if (input.isSelf) return "you";
  if (!input.hasAccount || !input.handle || !input.viewerSignedIn) return "none";
  if (input.outgoing === "accepted") return input.incoming === "accepted" ? "friends" : "following";
  if (input.outgoing === "pending") return "requested";
  return "add";
}

export interface OutingMember {
  participantId: string;
  name: string;
  handle: string | null;
  guest: boolean;
  isHost: boolean;
  isYou: boolean;
  hereNow: boolean;
  friend: MemberFriendState;
}
