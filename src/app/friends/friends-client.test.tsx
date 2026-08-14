// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FriendsClient } from "@/app/friends/friends-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("FriendsClient", () => {
  it("approves a request: calls the approve route and moves the row into Followers", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { approved: true } });
    render(<FriendsClient requests={[requester]} following={[]} followers={[]} blocked={[]} />);

    expect(screen.getByText("Req User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /approve requester/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-req/approve", { method: "POST" });
    const followersSection = screen.getByText("Followers").closest("section")!;
    expect(await within(followersSection).findByText("Req User")).toBeInTheDocument();
    expect(screen.queryByText("Requests")).not.toBeInTheDocument();
  });

  it("unfollows: calls the DELETE route and removes the row from Following", async () => {
    const fetchMock = mockFetchOnce({ ok: true, body: { removed: true } });
    render(<FriendsClient requests={[]} following={[followingAccepted]} followers={[]} blocked={[]} />);

    expect(screen.getByText("Following User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows/u-following", { method: "DELETE" });
    expect(await screen.findByText("Not following anyone yet.")).toBeInTheDocument();
  });

  it("shows a Friends chip for mutual follows", () => {
    render(<FriendsClient requests={[]} following={[mutualFriend]} followers={[follower]} blocked={[]} />);
    expect(screen.getByText("Friends")).toBeInTheDocument();
  });

  it("surfaces a section error when a mutation fails", async () => {
    mockFetchOnce({ ok: false });
    render(<FriendsClient requests={[]} following={[followingAccepted]} followers={[]} blocked={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /unfollow/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't go through/i);
    // Optimistic removal only happens on success — the row stays put.
    expect(screen.getByText("Following User")).toBeInTheDocument();
  });
});
