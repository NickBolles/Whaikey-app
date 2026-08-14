// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VisibilityControl } from "@/components/visibility-control";

afterEach(cleanup);

describe("VisibilityControl", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the current tier collapsed, then all 4 options when opened", () => {
    render(<VisibilityControl pourId="p1" visibility="private" />);
    expect(screen.getByText("Only me")).toBeInTheDocument();
    expect(screen.queryByText("Friends")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /only me/i }));
    expect(screen.getByRole("button", { name: "Friends" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Followers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Public" })).toBeInTheDocument();
  });

  it("optimistically updates and PATCHes /api/pours/[id] on selection", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ visibility: "friends" }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<VisibilityControl pourId="p1" visibility="private" />);
    fireEvent.click(screen.getByRole("button", { name: /only me/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Friends" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pours/p1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ visibility: "friends" }),
      }),
    );
    expect(screen.getByText("Friends")).toBeInTheDocument();
    expect(screen.queryByText("Only me")).not.toBeInTheDocument();
  });

  it("reverts to the previous value when the PATCH fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    render(<VisibilityControl pourId="p1" visibility="private" />);
    fireEvent.click(screen.getByRole("button", { name: /only me/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Public" }));
    });

    expect(screen.getByText("Only me")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't update/i);
  });
});
