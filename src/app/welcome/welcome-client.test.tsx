// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeClient, type WelcomeClientProps } from "./welcome-client";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // jsdom keeps cookies across tests on the shared document — clear ours.
  document.cookie = "whaikey_onboarded=; path=/; max-age=0";
});

function hasOnboardedCookie(): boolean {
  return document.cookie.includes("whaikey_onboarded=1");
}

type StubResponse = { status: number; body: unknown };

/** Route-based fetch stub: the wizard fires several different endpoints. */
function stubFetch(handler: (url: string, init?: RequestInit) => StubResponse | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = handler(url, init);
    if (!res) throw new Error(`Unexpected fetch in test: ${url}`);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const baseProps: WelcomeClientProps = {
  accountName: "Test Taster",
  suggestedHandle: "testtaster",
  initialProfile: null,
  initialPhoneLast2: null,
  initialPhoneDiscoverable: false,
};

const sarah = { userId: "u_sarah", handle: "sarah", displayName: "Sarah", avatarUrl: null };
const sarahTarget = {
  profile: sarah,
  isPublic: true,
  followState: null,
  followsYou: false,
  isSelf: false,
};

/** Step 1 -> 2 with a claimed profile prop, then -> 3. */
async function goToFriendsStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Set me up" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Find your friends" })).toBeInTheDocument();
}

describe("WelcomeClient", () => {
  it("walks forward with the primary CTA and back with the back button", async () => {
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    expect(screen.getByText("Whaikey")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set me up" }));
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Set me up" })).toBeInTheDocument();
  });

  it("Skip the tour sets the cookie and routes home", async () => {
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    expect(hasOnboardedCookie()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Skip the tour" }));

    expect(hasOnboardedCookie()).toBe(true);
    expect(push).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("a quiet Skip on a step sets the cookie and advances", async () => {
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Set me up" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(hasOnboardedCookie()).toBe(true);
    // Skipped the profile step, so the friends step explains a handle is needed.
    expect(screen.getByRole("heading", { name: "Find your friends" })).toBeInTheDocument();
    expect(screen.getByText("Friends come after a handle")).toBeInTheDocument();
  });

  it("claims a handle with the display name and advances to the friends step", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/social/profile" && init?.method === "POST") {
        return { status: 201, body: { handle: "testtaster", displayName: "Test Taster" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Set me up" }));
    expect(screen.getByLabelText("Display name")).toHaveValue("Test Taster");
    expect(screen.getByLabelText("Handle")).toHaveValue("testtaster");
    await user.click(screen.getByRole("button", { name: "Claim my handle" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(parseBody(init)).toEqual({ handle: "testtaster", displayName: "Test Taster" });
    expect(await screen.findByRole("heading", { name: "Find your friends" })).toBeInTheDocument();
  });

  it("shows the taken-handle copy on 409 and stays on the step", async () => {
    stubFetch((url, init) => {
      if (url === "/api/social/profile" && init?.method === "POST") {
        return { status: 409, body: { error: "handle_taken" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Set me up" }));
    await user.click(screen.getByRole("button", { name: "Claim my handle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
    expect(screen.getByRole("heading", { name: "Your profile" })).toBeInTheDocument();
  });

  it("shows the invalid-handle copy on 400", async () => {
    stubFetch((url, init) => {
      if (url === "/api/social/profile" && init?.method === "POST") {
        return { status: 400, body: { error: "invalid_handle" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} />);

    await user.click(screen.getByRole("button", { name: "Set me up" }));
    await user.click(screen.getByRole("button", { name: "Claim my handle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/3–20 characters/);
  });

  it("shows the existing-profile state and continues without posting", async () => {
    const fetchMock = stubFetch(() => undefined);
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);

    await user.click(screen.getByRole("button", { name: "Set me up" }));
    expect(screen.getByText(/You're @drammer\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Find your friends" })).toBeInTheDocument();
  });

  it("saves a phone with discoverable false unless the toggle was flipped", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/social/phone" && init?.method === "POST") {
        return { status: 200, body: { phoneLast2: "67", phoneDiscoverable: false } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);

    await user.type(screen.getByLabelText("Phone number"), "+1 555 123 4567");
    // Deliberately NOT touching "Let people find me by phone".
    await user.click(screen.getByRole("button", { name: "Save" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(parseBody(init)).toEqual({ phone: "+1 555 123 4567", discoverable: false });
    expect(await screen.findByText(/•••• ••67 · not discoverable/)).toBeInTheDocument();
  });

  it("saves a phone with discoverable true after the explicit opt-in", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/social/phone" && init?.method === "POST") {
        return { status: 200, body: { phoneLast2: "67", phoneDiscoverable: true } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);

    // The opt-in is never pre-selected.
    expect(screen.getByRole("switch", { name: /let people find me by phone/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await user.type(screen.getByLabelText("Phone number"), "+1 555 123 4567");
    await user.click(screen.getByRole("switch", { name: /let people find me by phone/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(parseBody(init)).toEqual({ phone: "+1 555 123 4567", discoverable: true });
    expect(await screen.findByText(/•••• ••67 · discoverable/)).toBeInTheDocument();
  });

  it("handle lookup renders a preview and follows only on the explicit tap", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith("/api/social/add-target?handle=sarah")) {
        return { status: 200, body: { target: sarahTarget } };
      }
      if (url === "/api/social/follows" && init?.method === "POST") {
        return { status: 200, body: { state: "accepted" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);

    await user.type(screen.getByLabelText("Handle or phone number to add"), "@Sarah");
    await user.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByText("Sarah")).toBeInTheDocument();
    // Nothing follows on lookup alone (docs/SOCIAL.md §7.2).
    const followCalls = fetchMock.mock.calls.filter(([u]) => String(u) === "/api/social/follows");
    expect(followCalls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Follow" }));
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === "/api/social/follows") as [
      string,
      RequestInit,
    ];
    expect(parseBody(init)).toEqual({ handle: "sarah" });
    expect(await screen.findByText("Following")).toBeInTheDocument();
  });

  it("a phone-shaped lookup goes through /api/social/lookup, then previews", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/social/lookup" && init?.method === "POST") {
        return { status: 200, body: { profile: sarah } };
      }
      if (url.startsWith("/api/social/add-target?handle=sarah")) {
        return { status: 200, body: { target: { ...sarahTarget, followState: "pending" } } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);

    await user.type(screen.getByLabelText("Handle or phone number to add"), "+1 555 123 4567");
    await user.click(screen.getByRole("button", { name: "Find" }));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(parseBody(init)).toEqual({ phone: "+1 555 123 4567" });
    expect(await screen.findByText("Sarah")).toBeInTheDocument();
    // An existing pending edge renders as state, never a second Follow button.
    expect(screen.getByText("Requested")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument();
  });

  it("adds a first bottle with the tapped relationship", async () => {
    const bottles = [
      {
        id: "b1",
        name: "Eagle Rare 10",
        category: "bourbon",
        distillery: "Buffalo Trace",
        region: null,
        ageYears: 10,
        abv: 45,
        avgPrice: null,
        flavorProfile: null,
      },
      {
        id: "b2",
        name: "Lagavulin 16",
        category: "scotch",
        distillery: "Lagavulin",
        region: "Islay",
        ageYears: 16,
        abv: 43,
        avgPrice: null,
        flavorProfile: null,
      },
    ];
    const fetchMock = stubFetch((url, init) => {
      if (url.startsWith("/api/bottles/search")) {
        return { status: 200, body: { results: bottles } };
      }
      if (url === "/api/user-bottles" && init?.method === "POST") {
        return { status: 201, body: { id: "ub1" } };
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Your first bottle" })).toBeInTheDocument();

    expect(await screen.findByText("Eagle Rare 10")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Eagle Rare 10 to bar" }));
    expect(await screen.findByText("In your bar")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Wishlist Lagavulin 16" }));
    expect(await screen.findByText("Wishlisted")).toBeInTheDocument();

    const posts = fetchMock.mock.calls
      .filter(([u, init]) => String(u) === "/api/user-bottles" && (init as RequestInit)?.method === "POST")
      .map(([, init]) => parseBody(init as RequestInit));
    expect(posts).toEqual([
      { bottleId: "b1", relationship: "own" },
      { bottleId: "b2", relationship: "wishlist" },
    ]);
  });

  it("finishing shows the You're set moment, sets the cookie, and Open Whaikey goes home", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/bottles/search")) return { status: 200, body: { results: [] } };
      return undefined;
    });
    const user = userEvent.setup();
    render(<WelcomeClient {...baseProps} initialProfile={{ handle: "drammer", displayName: "Dram Fan" }} />);
    await goToFriendsStep(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(hasOnboardedCookie()).toBe(true);
    expect(screen.getByText("You're set.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Whaikey" }));
    expect(push).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalled();
  });
});
