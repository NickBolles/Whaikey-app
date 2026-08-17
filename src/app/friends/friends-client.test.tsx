// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FriendsClient, type FriendsClientProps } from "@/app/friends/friends-client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
}));

// The QR pair reaches for canvas / native seams that don't exist in jsdom —
// this suite's own concern is the friends flow.
vi.mock("@/components/friend-qr", () => ({
  FriendQr: () => <button type="button">Show my code</button>,
}));
vi.mock("@/components/qr-scan-button", () => ({
  QrScanButton: () => <button type="button">Scan a code</button>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockClear();
});

function mockFetchOnce(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const requester = { userId: "u-req", handle: "requester", displayName: "Req User", avatarUrl: null };
const followingAccepted = { userId: "u-following", handle: "following", displayName: "Following User", avatarUrl: null, state: "accepted" as const, mutual: false };
const mutualFriend = { userId: "u-mutual", handle: "mutual", displayName: "Mutual Friend", avatarUrl: null, state: "accepted" as const, mutual: true };
const follower = { userId: "u-follower", handle: "follower", displayName: "Follower User", avatarUrl: null };
const blockedUser = { userId: "u-blocked", handle: "blocked", displayName: "Blocked User", avatarUrl: null };

const defaultProps: FriendsClientProps = {
  handle: "me",
  phoneLast2: null,
  phoneDiscoverable: false,
  requests: [],
  following: [],
  followers: [],
  blocked: [],
};

// The Find friends card also renders a tabpanel (its visible face), so the
// People panel is picked out by its accessible name — the active People tab.
const panel = () => screen.getByRole("tabpanel", { name: /following|followers|blocked/i });

describe("FriendsClient people tabs", () => {
  it("shows Following by default and switches to Followers on tap", async () => {
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} followers={[follower]} />);

    const followingTab = screen.getByRole("tab", { name: /following/i });
    const followersTab = screen.getByRole("tab", { name: /followers/i });
    expect(followingTab).toHaveAttribute("aria-selected", "true");
    expect(within(panel()).getByText("Following User")).toBeInTheDocument();
    expect(within(panel()).queryByText("Follower User")).not.toBeInTheDocument();

    await userEvent.click(followersTab);

    expect(followersTab).toHaveAttribute("aria-selected", "true");
    expect(followingTab).toHaveAttribute("aria-selected", "false");
    expect(within(panel()).getByText("Follower User")).toBeInTheDocument();
    expect(within(panel()).queryByText("Following User")).not.toBeInTheDocument();
  });

  it("shows a Blocked tab only when someone is blocked", () => {
    const { unmount } = render(<FriendsClient {...defaultProps} />);
    expect(screen.queryByRole("tab", { name: /blocked/i })).not.toBeInTheDocument();
    unmount();

    render(<FriendsClient {...defaultProps} blocked={[blockedUser]} />);
    expect(screen.getByRole("tab", { name: /blocked/i })).toBeInTheDocument();
  });

  it("falls back to Following when the last blocked row is unblocked", async () => {
    mockFetchOnce({ ok: true, body: { removed: true } });
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} blocked={[blockedUser]} />);

    await userEvent.click(screen.getByRole("tab", { name: /blocked/i }));
    await userEvent.click(screen.getByRole("button", { name: /unblock/i }));

    // The Blocked tab disappears with its last row; the panel falls back.
    expect(screen.queryByRole("tab", { name: /blocked/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /following/i })).toHaveAttribute("aria-selected", "true");
    expect(within(panel()).getByText("Following User")).toBeInTheDocument();
  });

  it("shows a Friends chip for mutual follows", () => {
    render(<FriendsClient {...defaultProps} following={[mutualFriend]} followers={[follower]} />);
    expect(screen.getByText("Friends")).toBeInTheDocument();
  });
});

describe("FriendsClient graph actions", () => {
  it("approves a request: calls the approve route and moves the row into Followers", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { approved: true } });
    render(<FriendsClient {...defaultProps} requests={[requester]} />);

    expect(screen.getByText("Requests (1)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /approve requester/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-req/approve", { method: "POST" });
    expect(screen.queryByText(/^Requests/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /followers/i }));
    expect(await within(panel()).findByText("Req User")).toBeInTheDocument();
  });

  it("unfollows: calls the DELETE route and removes the row optimistically", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { removed: true } });
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} />);

    expect(within(panel()).getByText("Following User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-following", { method: "DELETE" });
    expect(await screen.findByText("Not following anyone yet.")).toBeInTheDocument();
  });

  it("surfaces a section error when a mutation fails", async () => {
    mockFetchOnce({ ok: false });
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} />);

    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't go through/i);
    // Optimistic removal only happens on success — the row stays put.
    expect(screen.getByText("Following User")).toBeInTheDocument();
  });
});

describe("FriendsClient Find friends card (the single social hub)", () => {
  it("defaults to the Find people face, with the QR actions inside it", () => {
    render(<FriendsClient {...defaultProps} handle="jess" />);
    expect(screen.getByText("Find friends")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Find people" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Show my code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan a code" })).toBeInTheDocument();
    // The discovery face exists in the card but stays tucked behind its tab.
    expect(screen.queryByRole("textbox", { name: "Phone number" })).not.toBeInTheDocument();
  });

  it("switches to How you're found: phone settings + privacy link, add flow tucked away", async () => {
    render(<FriendsClient {...defaultProps} />);

    await userEvent.click(screen.getByRole("tab", { name: "How you're found" }));

    expect(screen.getByRole("tab", { name: "How you're found" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Phone number" })).toBeInTheDocument();
    // D8 as amended: the opt-in is never pre-selected, even reached this way.
    expect(screen.getByRole("switch", { name: "Let people find me by phone" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("link", { name: /privacy & sharing/i })).toHaveAttribute("href", "/sharing");
    expect(screen.queryByRole("button", { name: "Show my code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /handle or phone number to add/i })).not.toBeInTheDocument();
  });

  it("keeps the discovery face mounted across switches, so in-progress edits survive", async () => {
    render(<FriendsClient {...defaultProps} />);

    await userEvent.click(screen.getByRole("tab", { name: "How you're found" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Phone number" }), "+1555");
    await userEvent.click(screen.getByRole("tab", { name: "Find people" }));
    await userEvent.click(screen.getByRole("tab", { name: "How you're found" }));

    expect(screen.getByRole("textbox", { name: "Phone number" })).toHaveValue("+1555");
  });

  it("no longer renders the old bottom-of-page Discovery settings disclosure", () => {
    render(<FriendsClient {...defaultProps} />);
    expect(screen.queryByRole("button", { name: /discovery settings/i })).not.toBeInTheDocument();
  });
});

describe("FindFriendsCard (inside FriendsClient)", () => {
  it("routes an @handle straight to /add/[handle] without calling follow", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "@Nick");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/add/nick");
  });

  it("routes a plain handle (no @) the same way", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "nick");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(push).toHaveBeenCalledWith("/add/nick");
  });

  it("looks up a phone number and pushes /add/[handle] on a match", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      body: { profile: { userId: "u-nick", handle: "nick", displayName: "Nick", avatarUrl: null } },
    });
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "+15551234567");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/lookup",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ phone: "+15551234567" }) }),
    );
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/add/nick"));
  });

  it("shows a calm message when no one matches the phone number", async () => {
    mockFetchOnce({ ok: true, body: { profile: null } });
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "5551234567");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/no one found by that number/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a rate-limit message on 429", async () => {
    mockFetchOnce({ ok: false, status: 429, body: { error: "rate_limited" } });
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "5551234567");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/too many lookups/i);
  });
});
