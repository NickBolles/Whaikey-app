// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let native = true;
let permission = "prompt";
const enablePush = vi.fn(async () => "granted");
vi.mock("@/lib/native/platform", () => ({ isNativeApp: () => native }));
vi.mock("@/lib/native/push", () => ({
  pushPermissionState: async () => permission,
  enablePush: () => enablePush(),
}));

import { PushOffer } from "./push-offer";
import { PUSH_OFFER_COOLDOWN_MS, loadOfferState, mayOffer, notifySocialInteraction } from "@/lib/native/push-offer";

async function interact() {
  await act(async () => {
    notifySocialInteraction("cheers");
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  native = true;
  permission = "prompt";
  enablePush.mockClear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("PushOffer", () => {
  it("never shows at launch — only after a social interaction — and Turn on spends the OS prompt", async () => {
    render(<PushOffer />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await interact();
    expect(screen.getByRole("dialog", { name: "Know when friends answer?" })).toBeInTheDocument();
    expect(enablePush).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });
    expect(enablePush).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(loadOfferState().done).toBe(true);
    await interact();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Not now never calls the OS and waits out the cooldown", async () => {
    render(<PushOffer />);
    await interact();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(enablePush).not.toHaveBeenCalled();
    await interact();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const state = loadOfferState();
    expect(state.shown).toBe(1);
    expect(mayOffer(state, (state.lastShownAt ?? 0) + PUSH_OFFER_COOLDOWN_MS + 1)).toBe(true);
    expect(mayOffer({ ...state, shown: 2 }, Date.now() + 10 * PUSH_OFFER_COOLDOWN_MS)).toBe(false);
  });

  it("stays silent on the web, and when the OS already has an answer", async () => {
    native = false;
    const view = render(<PushOffer />);
    await interact();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.unmount();
    native = true;
    permission = "denied";
    render(<PushOffer />);
    await interact();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(loadOfferState().done).toBe(true);
  });

  it("explains a denial from the OS instead of silently closing", async () => {
    enablePush.mockResolvedValueOnce("denied");
    render(<PushOffer />);
    await interact();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    });
    expect(screen.getByText(/off for Whaikey in your phone's settings/)).toBeInTheDocument();
  });
});
