// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FriendButton } from "./outing-people";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FriendButton", () => {
  it("renders each state", () => {
    const { rerender, container } = render(<FriendButton handle="ann" initial="you" />);
    expect(screen.getByText("You")).toBeTruthy();
    rerender(<FriendButton key="f" handle="ann" initial="friends" />);
    expect(screen.getByText("Friends")).toBeTruthy();
    rerender(<FriendButton key="r" handle="ann" initial="requested" />);
    expect(screen.getByText("Requested")).toBeTruthy();
    rerender(<FriendButton key="n" handle={null} initial="none" />);
    expect(container.textContent).toBe("");
  });

  it("Add friend posts the handle and moves to Requested for a private profile", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: "pending" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FriendButton handle="ann" initial="add" />);
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));
    await waitFor(() => expect(screen.getByText("Requested")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/social/follows", expect.objectContaining({ method: "POST", body: JSON.stringify({ handle: "ann" }) }));
  });

  it("moves to Following when accepted straight away, and explains a missing handle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ state: "accepted" }), { status: 200 })));
    render(<FriendButton handle="ann" initial="add" />);
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));
    await waitFor(() => expect(screen.getByText("Following")).toBeTruthy());
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "profile_required" }), { status: 409 })));
    render(<FriendButton handle="ann" initial="add" />);
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Claim a handle/));
  });
});
