// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, replace }) }));
const shareMock = vi.fn(async () => "shared");
vi.mock("@/lib/native/share", () => ({ share: (...a: unknown[]) => shareMock(...(a as [])) }));

import {
  ClaimOutingSeatButton,
  FeedItemAction,
  JoinOutingButton,
  OutingHostControls,
  OutingNoteComposer,
  OutingWatcher,
  QuickAddTasting,
  RideReminder,
} from "./outing-client";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return handler(url, init);
    }),
  );
  return calls;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  push.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

describe("JoinOutingButton", () => {
  it("joins and refreshes, or asks for a profile on 409", async () => {
    const user = userEvent.setup();
    mockFetch(() => new Response("{}", { status: 200 }));
    render(<JoinOutingButton code="abc123def4" />);
    await user.click(screen.getByRole("button", { name: "Join the outing" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    cleanup();
    mockFetch(() => new Response("{}", { status: 409 }));
    render(<JoinOutingButton code="abc123def4" />);
    await user.click(screen.getByRole("button", { name: "Join the outing" }));
    expect(await screen.findByText(/Set up your profile first/)).toBeTruthy();
  });
});

describe("RideReminder", () => {
  it("shows once, and stays dismissed on this device", async () => {
    const user = userEvent.setup();
    render(<RideReminder code="abc123def4" />);
    expect(screen.getByRole("complementary", { name: "Getting there and back" }).textContent).toMatch(/designated driver/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    cleanup();
    render(<RideReminder code="abc123def4" />);
    expect(screen.queryByRole("complementary")).toBeNull();
    // Copy never counts anything.
    cleanup();
    render(<RideReminder code="other00000" />);
    expect(screen.getByRole("complementary").textContent).not.toMatch(/\d/);
  });
});

describe("QuickAddTasting", () => {
  it("logs a cask sample by name with a rating and descriptors", async () => {
    const user = userEvent.setup();
    const calls = mockFetch((url) =>
      url.startsWith("/api/bottles/search")
        ? Response.json({ results: [{ id: "eagle-rare-10", name: "Eagle Rare 10" }] })
        : new Response(JSON.stringify({ id: "t1" }), { status: 201 }),
    );
    render(<QuickAddTasting code="abc123def4" signedIn initialBottle={null} />);
    await user.type(screen.getByLabelText("What did they pour?"), "Cask 1142");
    expect(await screen.findByRole("button", { name: "Eagle Rare 10" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Add it to the catalog first/ }).getAttribute("href")).toBe(
      "/bottles/new?name=Cask%201142&next=%2Fo%2Fabc123def4",
    );
    await user.click(screen.getByRole("button", { name: /Log “Cask 1142” as poured here/ }));
    await user.click(screen.getByRole("radio", { name: "4 stars" }));
    await user.click(screen.getByRole("radio", { name: "4 stars" })); // toggles off
    await user.click(screen.getByRole("radio", { name: "5 stars" }));
    await user.click(screen.getByRole("button", { name: "Vanilla" }));
    await user.click(screen.getByRole("button", { name: "Oak" }));
    await user.click(screen.getByRole("button", { name: "Oak" })); // off again
    await user.type(screen.getByLabelText("Tasting note"), "From the barrel");
    await user.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText("Logged to the outing.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/outings/abc123def4/tastings");
    expect(post.body).toEqual({ label: "Cask 1142", rating: 5, flavorTags: { vanilla: 2 }, note: "From the barrel" });
    expect(refresh).toHaveBeenCalled();
  });

  it("starts with a bottle back from the add-a-bottle flow, and reports a closed outing or the cap", async () => {
    const user = userEvent.setup();
    let status = 409;
    const calls = mockFetch(() => new Response("{}", { status }));
    render(<QuickAddTasting code="abc123def4" signedIn={false} initialBottle={{ id: "b1", name: "My new bottle" }} />);
    expect(screen.getByText("My new bottle")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText("The host has ended this outing.")).toBeTruthy();
    expect(calls[0].body).toMatchObject({ bottleId: "b1", rating: null, flavorTags: null, note: null });
    status = 429;
    await user.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText(/the most one person can log/)).toBeTruthy();
    status = 500;
    await user.click(screen.getByRole("button", { name: "Log it" }));
    expect(await screen.findByText(/Couldn't save/)).toBeTruthy();
    status = 201;
    await user.click(screen.getByRole("button", { name: "Log it" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/o/abc123def4"));
    // Back to the search box; signed out offers no catalog link.
    await user.type(screen.getByLabelText("What did they pour?"), "Xy");
    expect(screen.queryByRole("link", { name: /Add it to the catalog/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /as poured here/ }));
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByLabelText("What did they pour?")).toBeTruthy();
  });
});

describe("OutingNoteComposer", () => {
  it("posts a note and clears", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => new Response("{}", { status: 201 }));
    render(<OutingNoteComposer code="abc123def4" />);
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(calls).toHaveLength(0);
    await user.type(screen.getByLabelText("Add a note for the group"), "Great tour");
    await user.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: "/api/outings/abc123def4/notes", body: { body: "Great tour" } });
    expect((screen.getByLabelText("Add a note for the group") as HTMLInputElement).value).toBe("");
  });
});

describe("FeedItemAction", () => {
  it("removes your own item or hides someone else's, after a confirm", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => new Response("{}", { status: 200 }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(
      <>
        <FeedItemAction code="c0de000000" kind="tasting" id="t1" mode="delete" />
        <FeedItemAction code="c0de000000" kind="note" id="n1" mode="hide" />
        <FeedItemAction code="c0de000000" kind="note" id="n2" mode="delete" />
      </>,
    );
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(calls).toHaveLength(0);
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/outings/c0de000000/tastings/t1",
      "POST /api/outings/c0de000000/hide",
      "DELETE /api/outings/c0de000000/notes/n2",
    ]);
    confirm.mockRestore();
  });
});

describe("OutingHostControls", () => {
  it("shares, invites mutual friends, ends and deletes", async () => {
    const user = userEvent.setup();
    let friends = [{ userId: "u2", handle: "sasha", displayName: "Sasha Glen" }, { userId: "u3", handle: "lee", displayName: null }];
    const calls = mockFetch((url, init) => {
      if (url.endsWith("/invite") && (init?.method ?? "GET") === "GET") return Response.json({ items: friends });
      if (url.endsWith("/invite")) {
        friends = friends.slice(1);
        return Response.json({ sent: 1 });
      }
      return Response.json({});
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<OutingHostControls code="c0de000000" title="Trip" state="open" />);
    await user.click(screen.getByRole("button", { name: "Share invite" }));
    expect(shareMock).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringMatching(/\/o\/c0de000000$/) }));
    await user.click(screen.getByRole("button", { name: "Invite friends" }));
    await user.click(await screen.findByRole("checkbox", { name: /Sasha Glen/ }));
    await user.click(screen.getByRole("checkbox", { name: /@lee/ }));
    await user.click(screen.getByRole("checkbox", { name: /@lee/ }));
    await user.click(screen.getByRole("button", { name: "Send invites" }));
    expect(await screen.findByText("1 invite sent.")).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/invite"))?.body).toEqual({ userIds: ["u2"] });
    await user.click(screen.getByRole("button", { name: /End & see recap/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/state"))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Delete outing" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/clubs"));
    confirm.mockRestore();
  });

  it("says when nobody is left to invite, and offers only delete once ended", async () => {
    const user = userEvent.setup();
    mockFetch(() => Response.json({ items: [] }));
    const { rerender } = render(<OutingHostControls code="c0de000000" title="Trip" state="open" />);
    await user.click(screen.getByRole("button", { name: "Invite friends" }));
    expect(await screen.findByText(/No friends left to invite/)).toBeTruthy();
    rerender(<OutingHostControls code="c0de000000" title="Trip" state="ended" />);
    expect(screen.queryByRole("button", { name: "Share invite" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete outing" })).toBeTruthy();
  });
});

describe("ClaimOutingSeatButton", () => {
  it("claims and refreshes", async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => Response.json({ claimed: true }));
    render(<ClaimOutingSeatButton code="c0de000000" />);
    await user.click(screen.getByRole("button", { name: "Keep what I logged" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0].url).toBe("/api/outings/c0de000000/claim");
  });
});

describe("OutingWatcher", () => {
  it("refreshes only when the stamp changes, and only while visible", async () => {
    vi.useFakeTimers();
    let stamp = "s1";
    const calls = mockFetch(() => Response.json({ state: "open", stamp }));
    render(<OutingWatcher code="c0de000000" stamp="s1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
    });
    expect(calls).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalled();
    stamp = "s2";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(calls).toHaveLength(2);
    vis.mockRestore();
  });
});
