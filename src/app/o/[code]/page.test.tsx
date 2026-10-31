// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { OutingView } from "@/lib/outings";

/**
 * The outing page's branches (D22): who sees what. The lib is mocked here —
 * its rules are tested against a real database in src/lib/outings — so this
 * covers only what the page chooses to render for each seat and state.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The host's QR renders asynchronously; a promise that settles after the
// test environment is torn down would setState into a dead window (an
// unhandled rejection on CI). The QR itself is not what this file tests.
vi.mock("qrcode", () => ({ default: { toDataURL: () => new Promise<string>(() => {}) } }));
let cookie: string | null = null;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }) }));
let sessionUser: { id: string; name: string; email: string } | null = null;
vi.mock("@/lib/session", () => ({ getSessionUser: async () => sessionUser }));
const bottle = { id: "b1", name: "Fresh submission", status: "user_submitted", submittedBy: "u1" };
vi.mock("@/db", () => ({ getDb: () => ({ query: { bottles: { findFirst: async () => bottle } } }) }));

let outing: { id: string; joinCode: string } | null = { id: "o1", joinCode: "abc123def4" };
type Seat = { participantId: string; userId: string | null; guest: boolean } | null;
let seat: Seat = null;
let guestSeat: Seat = null;
let view: OutingView;
vi.mock("@/lib/outings", () => ({
  outingGuestCookieName: (c: string) => `whaikey_outing_${c}`,
  formatVisitDay: (d: string) => `day ${d}`,
  visibleOutingByCode: async () => outing,
  findOutingSeat: async (_db: unknown, _id: string, who: { userId?: string | null; guestToken?: string | null }) => (who.userId ? seat : who.guestToken && !who.userId ? (guestSeat ?? seat) : null),
  getOutingView: async () => view,
}));

import OutingPage from "./page";

const baseView = (over: Partial<OutingView> = {}): OutingView => ({
  id: "o1",
  title: "Bourbon Trail Saturday",
  distilleryName: "Buffalo Trace",
  distilleryId: null,
  location: "Frankfort, KY",
  visitOn: "2026-10-31",
  rideReminder: true,
  state: "open",
  joinCode: "abc123def4",
  isHost: false,
  host: { handle: "jordan", displayName: "Jordan" },
  club: null,
  seat: null,
  people: [{ name: "@jordan", guest: false }],
  feed: [],
  recap: null,
  board: [],
  social: { comments: {}, reactions: {} },
  insights: null,
  recognitions: [],
  stamp: "s",
  ...over,
});

async function show(searchParams: Record<string, string> = {}) {
  const el = await OutingPage({ params: Promise.resolve({ code: "abc123def4" }), searchParams: Promise.resolve(searchParams) });
  render(el);
}

beforeEach(() => {
  cookie = null;
  sessionUser = null;
  outing = { id: "o1", joinCode: "abc123def4" };
  seat = null;
  guestSeat = null;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [] })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/o/[code]", () => {
  it("404s for an unknown or hidden outing", async () => {
    outing = null;
    await expect(show()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows a signed-out visitor the guest join form and nothing of the trip", async () => {
    view = baseView({ feed: [{ kind: "note", id: "n1", who: "Sasha", mine: false, text: "secret", createdAt: new Date() }] });
    await show();
    expect(screen.getByRole("heading", { name: "Bourbon Trail Saturday" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join the outing" })).toBeTruthy();
    expect(screen.getByLabelText("Date of birth")).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.queryByText(/@jordan,/)).toBeNull();
  });

  it("offers a signed-in visitor the join button, and says when it has ended", async () => {
    sessionUser = { id: "u9", name: "x", email: "x@x" };
    view = baseView();
    await show();
    expect(screen.getByRole("button", { name: "Join the outing" })).toBeTruthy();
    expect(screen.queryByLabelText("Date of birth")).toBeNull();
    cleanup();
    view = baseView({ state: "ended" });
    await show();
    expect(screen.getByText("This outing has ended.")).toBeTruthy();
  });

  it("gives the host the QR, controls, ride card, quick add and the feed with hide", async () => {
    sessionUser = { id: "u1", name: "Jordan", email: "j@x" };
    seat = { participantId: "p1", userId: "u1", guest: false };
    view = baseView({
      isHost: true,
      seat,
      club: { id: "c1", name: "Tuesday Drams" },
      people: [{ name: "@jordan", guest: false }, { name: "Pat", guest: true }],
      feed: [
        { kind: "tasting", id: "t1", who: "Pat", mine: false, label: "Cask 1142", bottleId: null, rating: 4, tags: ["Vanilla"], text: "wow", createdAt: new Date() },
        { kind: "tasting", id: "t2", who: "Jordan", mine: true, label: "Eagle Rare 10", bottleId: "er10", rating: null, tags: [], text: null, createdAt: new Date() },
        { kind: "note", id: "n1", who: "Pat", mine: false, text: "Great tour", createdAt: new Date() },
      ],
    });
    await show({ added: "b1" });
    expect(screen.getByText(/Tuesday Drams/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share invite" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Log a tasting" })).toBeTruthy();
    expect(screen.getByText("Fresh submission")).toBeTruthy(); // back from add-a-bottle, picked
    expect(screen.getAllByRole("button", { name: "Hide" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add to my journal →" }).getAttribute("href")).toBe("/pour?bottleId=er10");
    expect(screen.getByRole("link", { name: "Eagle Rare 10" }).getAttribute("href")).toBe("/bottles/er10");
    expect(screen.getByText("Great tour")).toBeTruthy();
  });

  it("tells a guest their rows expire and offers a signed-in guest to keep them", async () => {
    cookie = "tok";
    seat = { participantId: "g1", userId: null, guest: true };
    view = baseView({ seat, rideReminder: false });
    await show();
    expect(screen.getByText(/You’re a guest/)).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("link", { name: /Add it to the catalog/ })).toBeNull();
    cleanup();
    sessionUser = { id: "u5", name: "x", email: "x@x" };
    seat = null;
    guestSeat = { participantId: "g1", userId: null, guest: true };
    view = baseView();
    await show();
    expect(screen.getByRole("button", { name: "Keep what I logged" })).toBeTruthy();
  });

  it("shows the recap once ended — favourite, spread, bottles — with no counts", async () => {
    sessionUser = { id: "u2", name: "Sasha", email: "s@x" };
    seat = { participantId: "p2", userId: "u2", guest: false };
    view = baseView({
      state: "ended",
      seat,
      recap: {
        bottles: [
          { label: "Cask 1142", bottleId: null, average: 4.5, sharedTags: ["Vanilla"] },
          { label: "Eagle Rare 10", bottleId: "er10", average: null, sharedTags: [] },
        ],
        favorite: { label: "Cask 1142", bottleId: null, average: 4.5, sharedTags: ["Vanilla"], consensus: true },
        spread: [{ id: "sweet", label: "Sweet", color: "#e8a13c", share: 100 }],
        topTags: ["Vanilla"],
      },
    });
    await show();
    expect(screen.getByRole("heading", { name: "The recap" })).toBeTruthy();
    expect(screen.getByText("Group favorite")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Sweet 100%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share the recap card" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Log a tasting" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b\d+\s*(ml|oz|pours?)\b/i);
    cleanup();
    view = baseView({
      state: "ended",
      seat,
      recap: { bottles: [{ label: "Solo", bottleId: "s1", average: 4, sharedTags: [] }], favorite: { label: "Solo", bottleId: "s1", average: 4, sharedTags: [], consensus: false }, spread: [], topTags: [] },
    });
    await show();
    expect(screen.getByText("Top rated")).toBeTruthy();
    cleanup();
    view = baseView({ state: "ended", seat, recap: { bottles: [], favorite: null, spread: [], topTags: [] } });
    await show();
    expect(screen.getByText("Nothing was logged on this outing.")).toBeTruthy();
  });
});
