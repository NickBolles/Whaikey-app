import { describe, expect, it } from "vitest";
import { isChromeless, isTabRoute, parentRoute, routeLabel, TABS } from "@/lib/app-routes";

const SIGNED_IN = { signedIn: true, profileHandle: "ada" };
const SIGNED_OUT = { signedIn: false, profileHandle: null };

describe("isTabRoute", () => {
  it("is true for exactly the bottom-nav destinations", () => {
    for (const tab of TABS) expect(isTabRoute(tab.href)).toBe(true);
    expect(isTabRoute("/bar/")).toBe(true);
  });

  it("is false for anything nested under a tab, and every other route", () => {
    for (const path of ["/friends/requests", "/bottles/eagle-rare-10", "/history", "/search", "/u/ada", "/learn"]) {
      expect(isTabRoute(path)).toBe(false);
    }
  });
});

describe("isChromeless (review UX-14)", () => {
  it("covers sign-in, the welcome tour, share pages, the age gate and the update screen", () => {
    for (const path of ["/sign-in", "/welcome", "/s/sashalagav16", "/age", "/app-update"]) {
      expect(isChromeless(path)).toBe(true);
    }
  });

  it("does not catch routes that merely share a prefix", () => {
    // `/s` must not swallow `/search`, `/scan` or `/sharing`.
    for (const path of ["/search", "/scan", "/sharing", "/support", "/", "/bar"]) {
      expect(isChromeless(path)).toBe(false);
    }
  });
});

describe("routeLabel", () => {
  it("names the tabs by their nav labels", () => {
    expect(routeLabel("/")).toBe("Home");
    expect(routeLabel("/bar")).toBe("My Bar");
    expect(routeLabel("/friends")).toBe("Friends");
  });

  it("names the places a back button most often returns to", () => {
    expect(routeLabel("/history")).toBe("Journal");
    expect(routeLabel("/search")).toBe("Search");
    expect(routeLabel("/bottles/eagle-rare-10")).toBe("Bottle");
    expect(routeLabel("/bottles/eagle-rare-10/compare")).toBe("Compare");
    expect(routeLabel("/bottles/new")).toBe("Add a bottle");
    expect(routeLabel("/learn")).toBe("Whiskey School");
    expect(routeLabel("/learn/flavors")).toBe("Flavor wheel");
    expect(routeLabel("/learn/barrel-science")).toBe("Lesson");
  });

  it("names a profile by its handle, decoded", () => {
    expect(routeLabel("/u/sasha")).toBe("@sasha");
    expect(routeLabel("/u/caf%C3%A9")).toBe("@café");
    // A malformed escape is shown as-is rather than throwing in render.
    expect(routeLabel("/u/%E0%A4%A")).toBe("@%E0%A4%A");
  });

  it("returns null for a route it has no name for", () => {
    expect(routeLabel("/definitely-not-a-route")).toBeNull();
  });
});

describe("parentRoute — where back goes with no in-app history", () => {
  it("sends a bottle page to the viewer's bar, or to the catalog when signed out", () => {
    expect(parentRoute("/bottles/eagle-rare-10", SIGNED_IN)).toEqual({ href: "/bar", label: "My Bar" });
    expect(parentRoute("/bottles/eagle-rare-10", SIGNED_OUT)).toEqual({ href: "/search", label: "Search" });
  });

  it("sends a comparison to its own bottle", () => {
    expect(parentRoute("/bottles/lagavulin-16/compare", SIGNED_IN)).toEqual({
      href: "/bottles/lagavulin-16",
      label: "Bottle",
    });
  });

  it("sends lessons to Whiskey School, and the school to Home", () => {
    expect(parentRoute("/learn/what-is-whiskey", SIGNED_OUT)).toEqual({ href: "/learn", label: "Whiskey School" });
    expect(parentRoute("/learn/flavors", SIGNED_OUT)).toEqual({ href: "/learn", label: "Whiskey School" });
    expect(parentRoute("/learn", SIGNED_OUT)).toEqual({ href: "/", label: "Home" });
  });

  it("sends a passport badge to the viewer's own profile when they have one", () => {
    expect(parentRoute("/passport/country/Scotland", SIGNED_IN)).toEqual({ href: "/u/ada", label: "Profile" });
    expect(parentRoute("/passport/country/Scotland", { signedIn: true, profileHandle: null })).toEqual({
      href: "/",
      label: "Home",
    });
  });

  it("sends social pages to Friends", () => {
    for (const path of ["/u/sasha", "/add/sasha", "/notes/demo-friend-pour-1"]) {
      expect(parentRoute(path, SIGNED_IN)).toEqual({ href: "/friends", label: "Friends" });
    }
  });

  it("falls back to Home for the journal, the policies and anything unknown", () => {
    for (const path of ["/history", "/search", "/pour", "/terms", "/nope/nothing"]) {
      expect(parentRoute(path, SIGNED_IN)).toEqual({ href: "/", label: "Home" });
    }
  });
});
