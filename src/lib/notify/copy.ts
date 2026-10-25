import type { NotificationCategory } from "@/db/schema";

/**
 * Notification copy and grouping (docs/SOCIAL.md §7.5, D18).
 *
 * Pure, so the banned-copy test can render every template. The rule the copy
 * follows is the one SOCIAL §3.1 sets for every social surface: a notification
 * tells you somebody did something with you, never that you should pour,
 * never that you have been away, never a cadence. `notify-copy.test.ts`
 * renders every category and fails on the banned vocabulary.
 */

/** Settings groups — what a person switches on and off. */
export const NOTIFICATION_GROUPS = [
  {
    key: "follows",
    label: "Followers",
    description: "Someone follows you, asks to, or accepts your request.",
    categories: ["follower", "follow_request", "follow_accepted"],
    defaultOn: true,
  },
  {
    key: "cheers",
    label: "Cheers",
    description: "Someone cheers one of your notes. Off unless you turn it on.",
    categories: ["cheer"],
    // SOCIAL §7.5 defaults: follows and direct replies on, everything else
    // daily-batched or off. Cheers are neither, so they start off.
    defaultOn: false,
  },
  {
    key: "comments",
    label: "Comments and replies",
    description: "Someone comments on your note or replies to you.",
    categories: ["comment", "reply"],
    defaultOn: true,
  },
  {
    key: "friend_tasted",
    label: "Friends' notes on your bottles",
    description: "A friend shares a note on a bottle you own or wishlisted. At most one a day.",
    categories: ["friend_tasted"],
    defaultOn: true,
  },
  {
    key: "clubs",
    label: "Clubs and tasting nights",
    description: "Club invites and joins, a tasting night opening or being revealed.",
    categories: ["club", "flight"],
    defaultOn: true,
  },
  {
    key: "challenges",
    label: "Challenges",
    description: "A friend invites you to a challenge, or you complete one.",
    categories: ["challenge"],
    defaultOn: true,
  },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  categories: readonly NotificationCategory[];
  defaultOn: boolean;
}>;

export type NotificationGroupKey = (typeof NOTIFICATION_GROUPS)[number]["key"];

export function groupFor(category: NotificationCategory): (typeof NOTIFICATION_GROUPS)[number] {
  const group = NOTIFICATION_GROUPS.find((g) => (g.categories as readonly string[]).includes(category));
  if (!group) throw new Error(`notification category without a group: ${category}`);
  return group;
}

export interface CopyInput {
  category: NotificationCategory;
  /** The actor's current handle, or null for a system notification. */
  actorHandle: string | null;
  subjectId: string | null;
  data: Record<string, string | number | boolean> | null;
}

export interface RenderedCopy {
  text: string;
  /** Same-origin path only — the push tap and the inbox row both open it. */
  deepLink: string;
}

const at = (h: string | null) => (h ? `@${h}` : "Someone");
const str = (v: unknown, fallback = "") => (typeof v === "string" && v.length > 0 ? v : fallback);

/** Renders one notification. Unknown/missing context degrades to generic copy. */
export function renderNotification(input: CopyInput): RenderedCopy {
  const who = at(input.actorHandle);
  const profile = input.actorHandle ? `/u/${input.actorHandle}` : "/friends";
  const d = input.data ?? {};
  switch (input.category) {
    case "follower":
      return { text: `${who} started following you`, deepLink: profile };
    case "follow_request":
      return { text: `${who} asked to follow you`, deepLink: "/friends/people" };
    case "follow_accepted":
      return { text: `${who} accepted your follow request`, deepLink: profile };
    case "cheer":
      return { text: `${who} cheered your note`, deepLink: `/notes/${input.subjectId}` };
    case "comment":
      return { text: `${who} commented on your note`, deepLink: `/notes/${input.subjectId}` };
    case "reply":
      return { text: `${who} replied to your comment`, deepLink: `/notes/${input.subjectId}` };
    case "friend_tasted": {
      const where = d.relationship === "wishlist" ? "your wishlist" : "your shelf";
      const bottle = str(d.bottleName, "a bottle");
      return { text: `${who} shared a note on ${bottle} from ${where}`, deepLink: `/notes/${str(d.pourId)}` };
    }
    case "club": {
      const club = str(d.clubName, "your club");
      const link = `/clubs/${input.subjectId}`;
      if (d.event === "invite") return { text: `${who} invited you to ${club}`, deepLink: link };
      if (d.event === "joined") return { text: `${who} joined ${club}`, deepLink: link };
      return { text: `News from ${club}`, deepLink: link };
    }
    case "flight": {
      const title = str(d.flightTitle, "a tasting night");
      const link = `/f/${input.subjectId}`;
      if (d.event === "invite") return { text: `${who} invited you to ${title}`, deepLink: link };
      if (d.event === "revealed") return { text: `The bottles in ${title} are revealed`, deepLink: link };
      return { text: `${title} has an update`, deepLink: link };
    }
    case "challenge": {
      const title = str(d.challengeTitle, "a challenge");
      const link = `/challenges#${str(d.slug, input.subjectId ?? "")}`;
      if (d.event === "completed") return { text: `You completed ${title} — new crest on your passport`, deepLink: link };
      if (d.event === "invite") return { text: `${who} invited you to ${title}`, deepLink: link };
      return { text: `${title} has an update`, deepLink: link };
    }
  }
}

/**
 * Words a notification must never carry (SOCIAL §3.1 rule 4, D18): a nudge to
 * pour, a cadence reminder, or loss framing. Checked against every rendered
 * template by `notify-copy.test.ts`.
 */
export const BANNED_NOTIFICATION_PHRASES = [
  "pour",
  "drink now",
  "streak",
  "haven't logged",
  "havent logged",
  "don't break",
  "dont break",
  "time for a dram",
  "miss you",
  "it's been",
] as const;
