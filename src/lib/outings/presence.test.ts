import { describe, expect, it } from "vitest";
import { PRESENCE_WINDOW_MS, isHereNow, memberFriendState } from "./presence";

describe("isHereNow", () => {
  const now = new Date("2026-11-01T20:00:00Z");
  it("is false with no heartbeat", () => {
    expect(isHereNow(null, now)).toBe(false);
    expect(isHereNow(undefined, now)).toBe(false);
  });
  it("is true inside the two-minute window", () => {
    expect(isHereNow(new Date(now.getTime() - 10_000), now)).toBe(true);
    expect(isHereNow(new Date(now.getTime() - PRESENCE_WINDOW_MS), now)).toBe(true);
  });
  it("is false once the window passes", () => {
    expect(isHereNow(new Date(now.getTime() - PRESENCE_WINDOW_MS - 1), now)).toBe(false);
  });
  it("accepts ISO strings and ignores bad or far-future values", () => {
    expect(isHereNow(new Date(now.getTime() - 5_000).toISOString(), now)).toBe(true);
    expect(isHereNow("nope", now)).toBe(false);
    expect(isHereNow(new Date(now.getTime() + 10 * 60_000), now)).toBe(false);
  });
});

describe("memberFriendState", () => {
  const base = { isSelf: false, hasAccount: true, handle: "ann", viewerSignedIn: true, outgoing: null, incoming: null } as const;
  it("You for the viewer's own row", () => expect(memberFriendState({ ...base, isSelf: true })).toBe("you"));
  it("no button for guests, handle-less accounts or signed-out viewers", () => {
    expect(memberFriendState({ ...base, hasAccount: false, handle: null })).toBe("none");
    expect(memberFriendState({ ...base, handle: null })).toBe("none");
    expect(memberFriendState({ ...base, viewerSignedIn: false })).toBe("none");
  });
  it("Add when there is no follow", () => expect(memberFriendState(base)).toBe("add"));
  it("Add even if they follow the viewer", () => expect(memberFriendState({ ...base, incoming: "accepted" })).toBe("add"));
  it("Requested while pending", () => expect(memberFriendState({ ...base, outgoing: "pending" })).toBe("requested"));
  it("Following one-way, Friends when mutual", () => {
    expect(memberFriendState({ ...base, outgoing: "accepted" })).toBe("following");
    expect(memberFriendState({ ...base, outgoing: "accepted", incoming: "accepted" })).toBe("friends");
    expect(memberFriendState({ ...base, outgoing: "accepted", incoming: "pending" })).toBe("following");
  });
});
