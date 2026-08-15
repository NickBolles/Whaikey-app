// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FriendsClient, type FriendsClientProps } from "@/app/friends/friends-client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
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

const defaultProps: FriendsClientProps = {
  handle: "me",
  phoneLast2: null,
  phoneDiscoverable: false,
  requests: [],
  following: [],
  followers: [],
  blocked: [],
};

describe("FriendsClient", () => {
  it("approves a request: calls the approve route and moves the row into Followers", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { approved: true } });
    render(<FriendsClient {...defaultProps} requests={[requester]} />);

    expect(screen.getByText("Req User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /approve requester/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-req/approve", { method: "POST" });
    const followersSection = screen.getByText("Followers").closest("section")!;
    expect(await within(followersSection).findByText("Req User")).toBeInTheDocument();
    expect(screen.queryByText("Requests")).not.toBeInTheDocument();
  });

  it("unfollows: calls the DELETE route and removes the row from Following", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { removed: true } });
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} />);

    expect(screen.getByText("Following User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-following", { method: "DELETE" });
    expect(await screen.findByText("Not following anyone yet.")).toBeInTheDocument();
  });

  it("shows a Friends chip for mutual follows", () => {
    render(<FriendsClient {...defaultProps} following={[mutualFriend]} followers={[follower]} />);
    expect(screen.getByText("Friends")).toBeInTheDocument();
  });

  it("surfaces a section error when a mutation fails", async () => {
    mockFetchOnce({ ok: false });
    render(<FriendsClient {...defaultProps} following={[followingAccepted]} />);

    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't go through/i);
    // Optimistic removal only happens on success — the row stays put.
    expect(screen.getByText("Following User")).toBeInTheDocument();
  });

  it("renders the How friends find you card with the owner's handle", () => {
    render(<FriendsClient {...defaultProps} handle="jess" />);
    expect(screen.getByText("How friends find you")).toBeInTheDocument();
    expect(screen.getByText("@jess")).toBeInTheDocument();
  });
});

describe("AddFriendForm (inside FriendsClient)", () => {
  it("routes an @handle straight to /add/[handle] without calling follow", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "@Nick");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/add/nick");
  });

  it("routes a plain handle (no @) the same way", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "nick");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(push).toHaveBeenCalledWith("/add/nick");
  });

  it("looks up a phone number and pushes /add/[handle] on a match", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      body: { profile: { userId: "u-nick", handle: "nick", displayName: "Nick", avatarUrl: null } },
    });
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "+15551234567");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

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
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/no one found by that number/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a rate-limit message on 429", async () => {
    mockFetchOnce({ ok: false, status: 429, body: { error: "rate_limited" } });
    render(<FriendsClient {...defaultProps} />);

    await userEvent.type(screen.getByLabelText(/handle or phone number to add/i), "5551234567");
    await userEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/too many lookups/i);
  });
});
