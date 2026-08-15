// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,MOCK-${text}`),
}));
vi.mock("qrcode", () => ({ default: { toDataURL } }));

import { FriendQr } from "@/components/friend-qr";

afterEach(() => {
  cleanup();
  toDataURL.mockClear();
});

describe("FriendQr", () => {
  it("renders a QR image encoding the /add/[handle] URL once shown", async () => {
    render(<FriendQr handle="nick" />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show my code/i }));

    expect(toDataURL).toHaveBeenCalledWith(
      expect.stringContaining("/add/nick"),
      expect.anything(),
    );
    const img = await screen.findByRole("img", { name: /nick/i });
    expect(img).toHaveAttribute("src", expect.stringContaining("MOCK-"));
    expect(screen.getByText("@nick")).toBeInTheDocument();
  });

  it("hides the code again on Hide code", async () => {
    render(<FriendQr handle="nick" />);
    await userEvent.click(screen.getByRole("button", { name: /show my code/i }));
    await screen.findByRole("img");

    await userEvent.click(screen.getByRole("button", { name: /hide code/i }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show my code/i })).toBeInTheDocument();
  });

  it("shows a calm error if generation fails", async () => {
    toDataURL.mockRejectedValueOnce(new Error("boom"));
    render(<FriendQr handle="nick" />);
    await userEvent.click(screen.getByRole("button", { name: /show my code/i }));

    expect(await screen.findByText(/couldn't generate your code/i)).toBeInTheDocument();
  });
});
