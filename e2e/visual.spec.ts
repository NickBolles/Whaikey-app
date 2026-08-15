import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./fixtures";

/**
 * Visual regression suite. Screenshots are committed baselines under
 * e2e/__screenshots__/. After an intentional design change run:
 *   pnpm e2e:update
 * and review the diffs in the commit like any other code change.
 */

async function settle(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForLoadState("networkidle");
  // The recommendation rails fetch after hydration, so networkidle can be
  // reached while they are still showing "Finding bottles…". A baseline
  // captured mid-fetch is ~400px shorter than the settled page and fails
  // wherever the fetch wins the race — which is how CI renders it. Resolves
  // immediately on pages that have no rails.
  await page
    .getByText("Finding bottles…")
    .first()
    .waitFor({ state: "detached", timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // Sticky bars get painted at scroll seams in fullPage captures — pin them
  // into normal flow for screenshots so they appear once, at the page end.
  await page.addStyleTag({
    content: `nav[aria-label="Primary"], [data-sticky] { position: static !important; }`,
  });
}

function shot(name: string) {
  return `${name}.png`;
}

test.describe("signed out", () => {
  test("home hero", async ({ page }) => {
    await page.goto("/");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("signed-out-home"), { fullPage: true });
  });

  test("sign-in", async ({ page }) => {
    await page.goto("/sign-in");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("signed-out-sign-in"), { fullPage: true });
  });

  test("search empty state", async ({ page }) => {
    await page.goto("/search");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("search-empty"), { fullPage: true });
  });

  test("search results", async ({ page }) => {
    await page.goto("/search");
    await page.getByRole("searchbox").fill("eagle");
    await expect(page.getByText(/Eagle Rare 10/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("search-results"), { fullPage: true });
  });

  test("bottle detail (peated, with pairings)", async ({ page }) => {
    await page.goto("/bottles/lagavulin-16");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bottle-detail-lagavulin"), { fullPage: true });
  });

  test("bottle detail (bourbon)", async ({ page }) => {
    await page.goto("/bottles/eagle-rare-10");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bottle-detail-eagle-rare"), { fullPage: true });
  });

  test("learn hub", async ({ page }) => {
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: /Learn whiskey/i })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("learn-hub"), { fullPage: true });
  });

  test("learn lesson (cask science)", async ({ page }) => {
    await page.goto("/learn/barrel-science");
    await expect(page.getByRole("heading", { name: /Cask science/i })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("learn-lesson"), { fullPage: true });
  });

  test("flavor explorer (idle)", async ({ page }) => {
    await page.goto("/learn/flavors");
    await expect(page.getByRole("heading", { name: "The flavor wheel" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("learn-flavors"), { fullPage: true });
  });

  test("flavor explorer (family selected)", async ({ page }) => {
    await page.goto("/learn/flavors");
    await page.getByRole("button", { name: "Peaty / Smoky" }).click();
    await expect(page.getByText(/Where it comes from/i)).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("learn-flavors-selected"), { fullPage: true });
  });
});

test.describe("signed in (demo collector)", () => {
  // CI runners are UTC; pinning it here means a contributor in another zone
  // renders the same time-dependent copy rather than a spurious diff.
  test.use({ timezoneId: "UTC" });

  test.beforeEach(async ({ context, baseURL, page }) => {
    await signIn(context, baseURL!);
    // The "tonight" rail picks its heading and detail line from the current
    // hour, and those strings wrap differently — enough to reflow a full-page
    // /bar shot by 20px. Pinning per-test meant a new shot of that page could
    // forget to, and pass or fail on the hour CI happened to run at; pin it
    // for every signed-in shot instead so the baselines are about layout.
    await page.clock.setFixedTime(new Date("2026-07-19T19:30:00Z"));
  });

  test("home dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Welcome back/i)).toBeVisible();
    // The hero IS tonight's pick now; its heading is the pinned-clock guard
    // that used to sit on the /bar shots — if the fixed time stops taking,
    // this names the cause instead of leaving a 20px reflow to a pixel diff.
    await expect(page.getByRole("heading", { name: "Tonight’s pour" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("home-dashboard"), { fullPage: true });
  });

  test("my bar", async ({ page }) => {
    await page.goto("/bar");
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "For your palate" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-own"), { fullPage: true });
  });

  // The wheel is a couple percent of the full-page capture above, so a total
  // redraw of it still lands inside maxDiffPixelRatio. Snapshot the card on
  // its own, where the heat map is judged on its own pixels.
  test("my bar: flavor map", async ({ page }) => {
    await page.goto("/bar");
    const map = page.getByRole("region", { name: /flavor map/i });
    await expect(page.getByTestId("bar-flavor-wheel")).toBeVisible();
    await settle(page);
    await expect(map).toHaveScreenshot(shot("bar-flavor-map"));
  });

  test("my bar: palate on the same wheel", async ({ page }) => {
    await page.goto("/bar");
    const map = page.getByRole("region", { name: /flavor map/i });
    await page.getByRole("button", { name: "Weight by rating" }).click();
    await expect(page.getByText("You lean toward")).toBeVisible();
    await settle(page);
    await expect(map).toHaveScreenshot(shot("bar-palate-map"));
  });

  test("my bar: your notes against the label", async ({ page }) => {
    await page.goto("/bar");
    const map = page.getByRole("region", { name: /flavor map/i });
    await page.getByRole("tab", { name: "Compare" }).click();
    await expect(page.getByLabel("Calibration summary")).toBeVisible();
    await settle(page);
    await expect(map).toHaveScreenshot(shot("bar-compare-map"));
  });

  // The payoff: a descriptor the label names and this drinker never does,
  // with what they wrote in its place.
  test("my bar: a blind spot, drilled into", async ({ page }) => {
    await page.goto("/bar");
    const map = page.getByRole("region", { name: /flavor map/i });
    await page.getByRole("tab", { name: "Compare" }).click();
    await page.getByRole("button", { name: /Filter by Clove/ }).click();
    await expect(page.getByText(/instead/i).first()).toBeVisible();
    await settle(page);
    await expect(map).toHaveScreenshot(shot("bar-compare-blind-spot"));
  });

  test("tried: one control now picks the shelf and scopes the wheel", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("tab", { name: /Tried/ }).click();
    await expect(page.getByRole("tab", { name: /Tried/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-tried"), { fullPage: true });
  });

  test("wishlist, chosen from the filter panel", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("radio", { name: /Wishlist/ }).click();
    await expect(page.getByText(/Yamazaki/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-wishlist"), { fullPage: true });
  });

  test("the filter panel, open", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("checkbox", { name: "Open" }).click();
    await expect(page.getByRole("button", { name: "Remove Open filter" })).toBeVisible();
    await settle(page);
    await expect(page.getByLabel("Active filters")).toBeVisible();
    await expect(page.getByRole("heading", { name: "For your palate" })).toBeVisible();
    await expect(page).toHaveScreenshot(shot("bar-filter-panel"), { fullPage: true });
  });

  test("bottle detail with shelf state", async ({ page }) => {
    await page.goto("/bottles/eagle-rare-10");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bottle-detail-owned"), { fullPage: true });
  });

  test("pour flow: bottle picker", async ({ page }) => {
    await page.goto("/pour");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("pour-step-bottle"), { fullPage: true });
  });

  test("pour flow: rating + wheel", async ({ page }) => {
    await page.goto("/pour");
    await settle(page);
    // Pick a recent bottle to reach the rating step deterministically.
    await page.getByText(/Eagle Rare 10/i).first().click();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("pour-step-rate"), { fullPage: true });
  });

  test("pour flow: freeform + voice note capture", async ({ page }) => {
    await page.goto("/pour");
    await settle(page);
    await page.getByText(/Eagle Rare 10/i).first().click();
    // Note capture is above the fold now, so no disclosure to open: it is the
    // first thing offered after picking a bottle.
    await expect(page.getByRole("button", { name: /Auto-fill|Extract/i })).toBeVisible();
    // Typed text drives the on-device flavor pass, which is the part of this
    // surface that renders without any network call.
    await page.getByLabel("Say what you taste").fill("Loads of vanilla and oak, long finish");
    await expect(page.getByLabel("Flavors heard in your note")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("pour-note-capture"), { fullPage: true });
  });

  test("history journal", async ({ page }) => {
    await page.goto("/history");
    await expect(page.getByText(/Lagavulin/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("history"), { fullPage: true });
  });

  test("chat (unconfigured state)", async ({ page }) => {
    await page.goto("/chat");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("chat-empty"), { fullPage: true });
  });

  test("scan (manual fallback, empty session)", async ({ page }) => {
    await page.goto("/scan");
    // Headless has no camera: wait for the deterministic manual-entry state.
    await expect(page.getByLabel(/barcode number/i)).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("scan"), { fullPage: true });
  });

  test("import (paste step)", async ({ page }) => {
    await page.goto("/import");
    await expect(page.getByLabel(/paste csv/i)).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("import"), { fullPage: true });
  });

  // Social (docs/SOCIAL.md): Jordan and Sasha Glen are mutual friends, seeded
  // in e2e/demo-seed.ts. These screens exercise the follow graph, a note
  // discussion, the sharing/privacy hub, and a signed-in bearer-link
  // comparison — see CONTRACTS.md for the underlying data shapes.

  test("friends: following, followers, and a mutual", async ({ page }) => {
    await page.goto("/friends");
    // exact: the redesigned page adds a "Find friends" h2 alongside the h1.
    await expect(page.getByRole("heading", { name: "Friends", exact: true })).toBeVisible();
    await expect(page.getByText("Sasha Glen").first()).toBeVisible();
    await expect(page.getByText("Friends", { exact: true }).last()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("friends"), { fullPage: true });
  });

  test("add-confirm: Sasha's identity preview with the Following state", async ({ page }) => {
    await page.goto("/add/sasha");
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    await expect(page.getByText("Friends", { exact: true })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("add-confirm"), { fullPage: true });
  });

  test("a friend's profile: palate, signature descriptors, recent notes", async ({ page }) => {
    await page.goto("/u/sasha");
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    await expect(page.getByText("Recent notes")).toBeVisible();
    await expect(page.getByText(/Lagavulin/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("profile"), { fullPage: true });
  });

  test("note discussion: comparison, cheers, and a threaded reply", async ({ page }) => {
    await page.goto("/notes/demo-friend-pour-1");
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
    await expect(page.getByText(/did you get any of that/i)).toBeVisible();
    await expect(page.getByText("You've tasted this too")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("note-discussion"), { fullPage: true });
  });

  test("sharing: privacy controls, no shared links yet", async ({ page }) => {
    await page.goto("/sharing");
    await expect(page.getByRole("heading", { name: "Sharing", exact: true })).toBeVisible();
    await expect(page.getByText("No shared links yet")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("sharing"), { fullPage: true });
  });

  test("shared pour link: signed-in viewer gets a comparison and discussion", async ({ page }) => {
    await page.goto("/s/sashalagav16");
    await expect(page.getByRole("heading", { name: "Lagavulin 16" })).toBeVisible();
    await expect(page.getByText("You've tasted this too")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("share-comparison"), { fullPage: true });
  });

  // Onboarding wizard (/welcome). The demo collector already has a profile,
  // so the profile step renders its claimed state — that's a real state the
  // wizard supports and it keeps these shots deterministic with one seed.

  test("welcome: the tour intro", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("button", { name: "Set me up" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("welcome-intro"), { fullPage: true });
  });

  test("welcome: profile step", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: "Set me up" }).click();
    await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("welcome-profile"), { fullPage: true });
  });

  test("welcome: find your friends step", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: "Set me up" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Find your friends" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("welcome-friends"), { fullPage: true });
  });

  test("welcome: first bottle step", async ({ page }) => {
    await page.goto("/welcome");
    await page.getByRole("button", { name: "Set me up" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Your first bottle" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("welcome-bottle"), { fullPage: true });
  });
});
