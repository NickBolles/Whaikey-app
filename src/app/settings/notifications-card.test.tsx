// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const native = { value: false };
const permission = vi.fn();
const disablePush = vi.fn();
const enablePush = vi.fn();
vi.mock("@/lib/native/platform", () => ({ isNativeApp: () => native.value }));
vi.mock("@/lib/native/push", () => ({
  pushPermissionState: () => permission(),
  disablePush: () => disablePush(),
  enablePush: () => enablePush(),
}));

import { NotificationsCard, type NotificationSettingsJson } from "./notifications-card";

const initial: NotificationSettingsJson = {
  groups: { follows: true, cheers: true, comments: true, friend_tasted: true, clubs: true, challenges: true },
  pushEnabled: true,
  quietStart: null,
  quietEnd: null,
  timeZone: null,
};

const fetchMock = vi.fn();

beforeEach(() => {
  native.value = false;
  permission.mockReset().mockResolvedValue("granted");
  disablePush.mockReset().mockResolvedValue(true);
  enablePush.mockReset().mockResolvedValue("granted");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationsCard", () => {
  it("states the never-a-nudge rule and offers one switch per group", () => {
    render(<NotificationsCard initial={initial} pushAvailable={false} />);
    expect(screen.getByText(/never a nudge to pour/i)).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(6);
    // No push controls when the deployment has no sender.
    expect(screen.queryByLabelText(/push to my phone/i)).toBeNull();
    expect(permission).not.toHaveBeenCalled();
  });

  it("saves a group switch and reverts when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    render(<NotificationsCard initial={initial} pushAvailable={false} />);
    const cheers = screen.getByRole("switch", { name: "Cheers" });
    await userEvent.click(cheers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/settings",
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining('"cheers":false') }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(/couldn't save/i);
    expect(screen.getByRole("switch", { name: "Cheers" })).toHaveAttribute("aria-checked", "true");
  });

  it("turns quiet hours on with the browser's time zone", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      new Response(JSON.stringify({ ...initial, ...JSON.parse(String(init.body)) }), { status: 200 }),
    );
    render(<NotificationsCard initial={initial} pushAvailable />);
    await userEvent.click(screen.getByLabelText("Quiet hours"));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ quietStart: 1320, quietEnd: 480 });
    expect(typeof body.timeZone).toBe("string");
    expect(await screen.findByLabelText("Quiet from")).toHaveValue("22:00");
  });

  it("lets the app release a registered device", async () => {
    native.value = true;
    render(<NotificationsCard initial={initial} pushAvailable />);
    await userEvent.click(await screen.findByRole("button", { name: /unregister this device/i }));
    expect(disablePush).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status")).toHaveTextContent(/no longer registered/i);
  });

  it("offers to allow notifications on a device that never registered", async () => {
    native.value = true;
    permission.mockResolvedValue("prompt");
    render(<NotificationsCard initial={initial} pushAvailable />);
    await userEvent.click(await screen.findByRole("button", { name: /allow notifications/i }));
    expect(enablePush).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /unregister this device/i })).toBeInTheDocument();
  });
});
