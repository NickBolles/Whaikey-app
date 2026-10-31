import { describe, expect, it } from "vitest";
import { OUTING_REACTIONS, buildOutingSocial, outingReactionSchema, parseMentions } from "./social";

const members = [
  { participantId: "a", name: "Ana Ruiz", handle: "ana_r" },
  { participantId: "b", name: "Ben", handle: null },
];
const at = (s: number) => new Date(Date.UTC(2026, 9, 29, 20, 0, s));

describe("reactions config", () => {
  it("is a fixed set about tasting, never drinking", () => {
    expect(OUTING_REACTIONS.map((r) => r.id)).toEqual(["agree", "same_here", "surprised", "want_to_try", "great_note", "learned", "not_for_me", "brave_pick"]);
    for (const r of OUTING_REACTIONS) expect(`${r.label} ${r.hint}`).not.toMatch(/drink|shot|cheers|pour|another|round/i);
    expect(outingReactionSchema.safeParse({ targetKind: "bottle", targetId: "b:1", kind: "cheers", on: true }).success).toBe(false);
  });
});

describe("parseMentions", () => {
  it("matches handles and first names of members, never the author", () => {
    expect(parseMentions("@ana_r and @ben agree", members, null).sort()).toEqual(["a", "b"]);
    expect(parseMentions("@Ana try this", members, "a")).toEqual([]);
    expect(parseMentions("email me at x@y", members, null)).toEqual([]);
    expect(parseMentions("@stranger", members, null)).toEqual([]);
  });
});

describe("buildOutingSocial", () => {
  const comments = [
    { id: "c1", participantId: "a", targetKind: "bottle", targetId: "b:1", body: "Smoky @Ben", mentions: ["b"], editedAt: null, hiddenAt: null, createdAt: at(1) },
    { id: "c2", participantId: "z", targetKind: "bottle", targetId: "b:1", body: "from a blocked person", mentions: [], editedAt: null, hiddenAt: null, createdAt: at(2) },
    { id: "c3", participantId: "b", targetKind: "bottle", targetId: "b:1", body: "hidden by host", mentions: [], editedAt: null, hiddenAt: at(3), createdAt: at(3) },
    { id: "c4", participantId: "b", targetKind: "tasting", targetId: "t1", body: "Agreed", mentions: ["z"], editedAt: at(5), hiddenAt: null, createdAt: at(4) },
  ];
  const reactions = [
    { participantId: "a", targetKind: "bottle", targetId: "b:1", kind: "agree" },
    { participantId: "b", targetKind: "bottle", targetId: "b:1", kind: "agree" },
    { participantId: "z", targetKind: "bottle", targetId: "b:1", kind: "agree" },
    { participantId: "b", targetKind: "bottle", targetId: "b:1", kind: "retired_kind" },
  ];
  it("drops blocked/hidden people and host-hidden replies, shows who reacted", () => {
    const s = buildOutingSocial(comments, reactions, members, "b");
    expect(s.comments["bottle:b:1"].map((c) => c.id)).toEqual(["c1"]);
    expect(s.comments["bottle:b:1"][0].mentionsMe).toBe(true);
    expect(s.comments["bottle:b:1"][0].mentions).toEqual(["You"]);
    expect(s.comments["tasting:t1"][0]).toMatchObject({ mine: true, edited: true, mentions: [] });
    expect(s.reactions["bottle:b:1"]).toEqual([{ kind: "agree", label: "Agree", glyph: "✓", count: 2, who: ["Ana Ruiz", "You"], mine: true }]);
  });
  it("drops replies on targets no longer on the board", () => {
    const s = buildOutingSocial(comments, reactions, members, "b", new Set(["tasting:t1"]));
    expect(s.comments["bottle:b:1"]).toBeUndefined();
    expect(s.reactions["bottle:b:1"]).toBeUndefined();
  });
});
