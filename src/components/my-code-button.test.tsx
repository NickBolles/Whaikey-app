// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toDataURL } = vi.hoisted(() => ({
  toDataURL: vi.fn(async (text: string) => `data:image/png;base64,MOCK-${text}`),
}));
vi.mock("qrcode", () => ({ default: { toDataURL } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { MyCodeButton, addLink } from "@/components/my-code-button";

afterEach(() => {
  cleanup();
  toDataURL.mockClear();
  vi.unstubAllGlobals();
  // @ts-expect-error -- test cleanup of an optional browser API
  delete navigator.share;
});

describe("MyCodeButton", () => {
  it("builds the /add/[handle] link", () => {
    expect(addLink("https://x.test", "nick")).toBe("https://x.test/add/nick");
  });

  it("opens a sheet with the QR for a known handle, shares it, and closes on Escape", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    render(<MyCodeButton handle="nick" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "My code" }));
    expect(screen.getByRole("dialog", { name: "My code" })).toBeInTheDocument();
    const img = await screen.findByRole("img", { name: /add @nick/i });
    expect(img).toHaveAttribute("src", expect.stringContaining("/add/nick"));
    expect(screen.getByText("@nick")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Share link/ }));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/add/nick") }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("copies the link when there is no share sheet", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<MyCodeButton handle="nick" variant="button" />);
    await userEvent.click(screen.getByRole("button", { name: /My code/ }));
    await userEvent.click(screen.getByRole("button", { name: /Share link/ }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/add/nick"));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });

  it("reads the handle on open when the page didn't pass one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ profile: { handle: "sam" } }) })));
    render(<MyCodeButton />);
    await userEvent.click(screen.getByRole("button", { name: "My code" }));
    expect(await screen.findByText("@sam")).toBeInTheDocument();
  });

  it("points at claiming a handle when there is no profile, and reports a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ profile: null }) })));
    render(<MyCodeButton />);
    await userEvent.click(screen.getByRole("button", { name: "My code" }));
    expect(await screen.findByRole("link", { name: /Claim one/ })).toHaveAttribute("href", "/friends/people");
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    render(<MyCodeButton />);
    await userEvent.click(screen.getByRole("button", { name: "My code" }));
    expect(await screen.findByText(/Couldn't load your code/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // A failed read is not sticky: reopening asks again.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ profile: { handle: "sam" } }) })));
    await userEvent.click(screen.getByRole("button", { name: "My code" }));
    expect(await screen.findByText("@sam")).toBeInTheDocument();
  });
});
