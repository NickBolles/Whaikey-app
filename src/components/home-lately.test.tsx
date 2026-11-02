// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => ({ show: vi.fn() }) }));

import { HomeLately, resetLatelyTabForTests, type HomeLatelyProps } from "@/components/home-lately";
import { LATELY_TAB_STORAGE_KEY } from "@/lib/home-feed";
import { measureMore } from "@/components/h-scroller";

const sasha = { userId: "u-sasha", handle: "sasha", displayName: "Sasha", avatarUrl: null };

function props(over: Partial<HomeLatelyProps> = {}): HomeLatelyProps {
  return {
    viewerId: "viewer",
    pours: [
      {
        id: "p1",
        bottleId: "b1",
        bottleName: "Demo Glen 12",
        rating: 4.2,
        createdAt: "2026-10-20T00:00:00.000Z",
        bottleCategory: "scotch",
        bottleRegion: null,
        bottleCountry: null,
        bottleImageUrl: null,
      },
    ],
    badge: { label: "Islay", tierLabel: "Silver II", detail: "3 distinct bottles met", href: "/passport/region/Islay", family: "region", value: "Islay", tier: 2 },
    friendItems: Array.from({ length: 7 }, (_, i) => ({
      pourId: `f${i}`,
      bottleId: `fb${i}`,
      bottleName: `Friend Bottle ${i}`,
      rating: 4,
      createdAt: `2026-10-${String(29 - i).padStart(2, "0")}T00:00:00.000Z`,
      visibility: "friends",
      author: i < 2 ? sasha : { userId: `u${i}`, handle: `pal${i}`, displayName: `Pal ${i}`, avatarUrl: null },
    })),
    hasProfile: true,
    hasFollows: true,
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetLatelyTabForTests();
});
afterEach(cleanup);

describe("HomeLately", () => {
  it("defaults to You: badge row first, then your tastings", () => {
    render(<HomeLately {...props()} />);
    expect(screen.getByRole("button", { name: "You" })).toHaveAttribute("aria-pressed", "true");
    const list = screen.getByTestId("lately-you");
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-feed-card", "badge");
    expect(rows[0]).toHaveTextContent("Badge earned · Islay · Silver II");
    expect(rows[1]).toHaveTextContent("Demo Glen 12");
  });

  it("switches to Friends, collapses the same friend into one row, and pages at 5", () => {
    render(<HomeLately {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Friends" }));
    expect(window.localStorage.getItem(LATELY_TAB_STORAGE_KEY)).toBe("friends");
    const list = screen.getByTestId("lately-friends");
    const rows = within(list).getAllByRole("listitem");
    // 7 items from 6 people → 6 rows, 5 shown.
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveAttribute("data-feed-card", "friend-group");
    expect(within(rows[0]).getByRole("link")).toHaveAttribute("href", "/u/sasha");
    expect(within(rows[1]).getByRole("link")).toHaveAttribute("href", "/notes/f2");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(screen.getByTestId("lately-friends")).getAllByRole("listitem")).toHaveLength(6);
  });

  it("remembers the choice on this device", () => {
    window.localStorage.setItem(LATELY_TAB_STORAGE_KEY, "friends");
    render(<HomeLately {...props()} />);
    expect(screen.getByRole("button", { name: "Friends" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("lately-friends")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "You" }));
    });
    expect(window.localStorage.getItem(LATELY_TAB_STORAGE_KEY)).toBe("you");
  });

  it("still switches when storage writes throw", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    render(<HomeLately {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Friends" }));
    expect(screen.getByRole("button", { name: "Friends" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("lately-friends")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("drops private friend pours and never shows a friend's badge", () => {
    const p = props({
      friendItems: [
        { pourId: "x", bottleId: "bx", bottleName: "Secret Bottle", rating: 5, createdAt: "2026-10-29T00:00:00.000Z", visibility: "private", author: sasha },
      ],
    });
    window.localStorage.setItem(LATELY_TAB_STORAGE_KEY, "friends");
    render(<HomeLately {...p} />);
    expect(screen.queryByText(/Secret Bottle/)).toBeNull();
    expect(screen.queryByText(/Badge earned/)).toBeNull();
    expect(screen.getByTestId("lately-empty")).toHaveTextContent("Quiet week");
  });

  it("without follows the Friends side is a one-line invite", () => {
    window.localStorage.setItem(LATELY_TAB_STORAGE_KEY, "friends");
    render(<HomeLately {...props({ hasFollows: false })} />);
    expect(screen.getByTestId("lately-empty")).toHaveAttribute("href", "/friends/people");
    expect(screen.queryByTestId("lately-friends")).toBeNull();
  });

  it("carries no streak, volume or right-now copy", () => {
    const { container } = render(<HomeLately {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Friends" }));
    expect(container.textContent).not.toMatch(/streak|in a row|drinking now|pours? (this|today)/i);
  });
});

describe("measureMore (scroller fade)", () => {
  it("fades only while there is more to the right", () => {
    expect(measureMore({ scrollLeft: 0, scrollWidth: 900, clientWidth: 390 })).toBe(true);
    expect(measureMore({ scrollLeft: 510, scrollWidth: 900, clientWidth: 390 })).toBe(false);
    expect(measureMore({ scrollLeft: 0, scrollWidth: 390, clientWidth: 390 })).toBe(false);
  });
});
