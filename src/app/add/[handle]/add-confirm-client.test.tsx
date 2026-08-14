// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddConfirmClient } from "@/app/add/[handle]/add-confirm-client";
import type { AddTarget } from "@/lib/social";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseTarget: AddTarget = {
  profile: { userId: "u-nick", handle: "nick", displayName: "Nick", avatarUrl: null },
  isPublic: true,
  followState: null,
  followsYou: false,
  isSelf: false,
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("AddConfirmClient", () => {
  it("follows and shows the Following state plus Back to Friends", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { state: "accepted" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AddConfirmClient target={baseTarget} />);
    expect(screen.getByText("Nick")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /follow/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/follows",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ handle: "nick" }) }),
    );
    expect(await screen.findByText("Following")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to friends/i })).toBeInTheDocument();
  });

  it("shows Requested when the target is private", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { state: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AddConfirmClient target={{ ...baseTarget, isPublic: false }} />);
    await userEvent.click(screen.getByRole("button", { name: /follow/i }));

    expect(await screen.findByText("Requested")).toBeInTheDocument();
  });

  it("renders the existing follow state without a fetch when already following", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<AddConfirmClient target={{ ...baseTarget, followState: "accepted", followsYou: true }} />);

    expect(screen.getByText("Following")).toBeInTheDocument();
    expect(screen.getByText("Friends")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to friends/i })).toBeInTheDocument();
  });

  it("renders ProfileClaim inline on profile_required, then retries the follow", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/social/follows") {
        // First attempt (no profile yet) fails; the retry after claiming succeeds.
        if (fetchMock.mock.calls.filter((c) => c[0] === "/api/social/follows").length === 1) {
          return jsonResponse(409, { error: "profile_required" });
        }
        return jsonResponse(200, { state: "accepted" });
      }
      if (url === "/api/social/profile") {
        return jsonResponse(200, { userId: "u-me", handle: "meuser", displayName: "Me", avatarUrl: null });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddConfirmClient target={baseTarget} />);
    await userEvent.click(screen.getByRole("button", { name: /^follow$/i }));

    expect(await screen.findByText(/claim a handle to follow/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/handle/i), "meuser");
    await userEvent.click(screen.getByRole("button", { name: /claim handle/i }));

    expect(await screen.findByText("Following")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/social/follows")).toHaveLength(2);
  });
});
