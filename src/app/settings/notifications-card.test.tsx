// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const native = { value: false };
const permission = vi.fn();
const disablePush = vi.fn();
vi.mock("@/lib/native/platform", () => ({ isNativeApp: () => native.value }));
vi.mock("@/lib/native/push", () => ({
  pushPermissionState: () => permission(),
  disablePush: () => disablePush(),
}));

import { NotificationsCard } from "./notifications-card";

beforeEach(() => {
  native.value = false;
  permission.mockReset().mockResolvedValue("granted");
  disablePush.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe("NotificationsCard", () => {
  it("says there are none, and never offers a switch with nothing behind it", () => {
    render(<NotificationsCard />);
    expect(screen.getByText(/doesn.t send notifications yet/i)).toBeInTheDocument();
    expect(screen.getByText(/never a nudge to pour/i)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // On the web there is no device to ask about.
    expect(permission).not.toHaveBeenCalled();
  });

  it("lets the app release a registered device", async () => {
    native.value = true;
    render(<NotificationsCard />);
    await userEvent.click(await screen.findByRole("button", { name: /unregister this device/i }));
    expect(disablePush).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent(/no longer registered/i);
    expect(screen.queryByRole("button", { name: /unregister/i })).toBeNull();
  });

  it("says so when the release fails, and keeps the control", async () => {
    native.value = true;
    disablePush.mockResolvedValue(false);
    render(<NotificationsCard />);
    await userEvent.click(await screen.findByRole("button", { name: /unregister this device/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/still registered/i);
    expect(screen.getByRole("button", { name: /unregister/i })).toBeInTheDocument();
  });

  it("shows nothing to release on a device that never registered", async () => {
    native.value = true;
    permission.mockResolvedValue("prompt");
    render(<NotificationsCard />);
    await Promise.resolve();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
