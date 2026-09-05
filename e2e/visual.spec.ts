import { expect, test, type Page } from "@playwright/test";
import { GATE_SESSION_TOKEN, signIn } from "./fixtures";

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
  // Home renders two rails (hero + discovery) that both show this copy, so
  // wait for every instance to clear, not just the first.
  await expect(page.getByText("Finding bottles…")).toHaveCount(0, { timeout: 15_000 });
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

  /**
   * The store-prerequisite pages (PLAN.md §9.3/§9.7, WP-18). Captured signed
   * out because that is how a store reviewer and a search engine reach them,
   * and captured with the legal identity unset — the "not finished" banner is
   * a state that has to be visible, not one to hide behind a fixture.
   *
   * `/admin/*` has no baseline on purpose: an internal tool for one operator,
   * deliberately outside the design system (docs/STORYBOARD.md §3.17).
   */
  test("terms", async ({ page }) => {
    await page.goto("/terms");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("terms"), { fullPage: true });
  });

  test("privacy policy", async ({ page }) => {
    await page.goto("/privacy");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("privacy"), { fullPage: true });
  });

  test("support", async ({ page }) => {
    await page.goto("/support");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("support"), { fullPage: true });
  });

  test("search empty state", async ({ page }) => {
    await page.goto("/search");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("search-empty"), { fullPage: true });
  });

  /**
   * The end of the dead end (review PLAN-A1). A search that finds nothing is
   * an ordinary outcome on a 269-bottle catalog, so the shot that matters is
   * the one with somewhere to go in it.
   */
  test("search: nothing found, with a way out", async ({ page }) => {
    await page.goto("/search");
    await page.getByRole("searchbox").fill("zzzz no such bottle");
    await expect(page.getByText("No bottles found")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("search-no-results"), { fullPage: true });
  });

  /**
   * The screen an outage renders. It is the last thing a bad deploy still
   * shows and the only lever a remote-URL app has, so it gets a baseline like
   * any other screen — see docs/STORYBOARD.md §3.15.
   */
  test("update required", async ({ page }) => {
    await page.goto("/app-update");
    await expect(page.getByRole("heading", { name: "Update Whaikey" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("app-update"), { fullPage: true });
  });

  test("responsible drinking", async ({ page }) => {
    await page.goto("/responsible");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("responsible"), { fullPage: true });
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
    // Month-in-review header: pinned server clock (WHAIKEY_FAKE_NOW) = July.
    await expect(page.getByText("JULY", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Your month" })).toBeVisible();
    // The hero IS tonight's pick now; its heading is the pinned-clock guard
    // that used to sit on the /bar shots — if the fixed time stops taking,
    // this names the cause instead of leaving a 20px reflow to a pixel diff.
    await expect(page.getByRole("heading", { name: "Tonight’s pour" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("home-dashboard"), { fullPage: true });
  });

  test("add a bottle the catalog lacks", async ({ page }) => {
    await page.goto("/bottles/new?source=search&name=Barrell%20Dovetail");
    await expect(page.getByRole("heading", { name: "Add a bottle" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bottle-new"), { fullPage: true });
  });

  test("my bar", async ({ page }) => {
    await page.goto("/bar");
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible();
    await expect(page.getByRole("region", { name: /flavor map/i })).toBeVisible();
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

  test("tried: one quick pick swaps the shelf and scopes the wheel", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("button", { name: "Tried", exact: true }).click();
    await expect(page.getByRole("button", { name: "Tried", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-tried"), { fullPage: true });
  });

  test("open: the quick state pick narrows stats, wheel, and list", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-open"), { fullPage: true });
  });

  test("wishlist, chosen from the filter panel", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByRole("radio", { name: /Wishlist/ }).click();
    await expect(page.getByText(/Yamazaki/i).first()).toBeVisible();
    // Close the panel so the shot is about the wishlist, not the panel.
    await page.getByRole("button", { name: /Filters/ }).click();
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
    await expect(page.getByRole("region", { name: /flavor map/i })).toBeVisible();
    await expect(page).toHaveScreenshot(shot("bar-filter-panel"), { fullPage: true });
  });

  test("bottle detail with shelf state", async ({ page }) => {
    await page.goto("/bottles/eagle-rare-10");
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bottle-detail-owned"), { fullPage: true });
  });

  test("your note, compared: friends reference", async ({ page }) => {
    await page.goto("/bottles/lagavulin-16/compare");
    await expect(page.getByRole("heading", { name: "Your note, compared" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Distillery note" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("compare-friends"), { fullPage: true });
  });

  test("your note, compared: professional reference, same screen", async ({ page }) => {
    await page.goto("/bottles/lagavulin-16/compare");
    await page.getByRole("tab", { name: "Professional" }).click();
    await expect(page.getByText("The Malt Journal")).toBeVisible();
    // The distillery card is the fixed reference — still visible here.
    await expect(page.getByRole("region", { name: "Distillery note" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("compare-professional"), { fullPage: true });
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

  test("scan (live camera, label suggestion)", async ({ page }) => {
    // Deterministic fake camera: a statically painted "bottle label" streamed
    // from a canvas, so the live viewfinder (controls, guidance, suggestion
    // strip) renders without hardware. BarcodeDetector is removed so every
    // environment takes the same barcode-free live-ID path, and the label
    // reader's API is stubbed for a stable one-tap suggestion.
    await page.addInitScript(() => {
      delete (window as { BarcodeDetector?: unknown }).BarcodeDetector;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const draw = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#241a12"; // dark shelf
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = "#e8d9b5"; // paper label
        ctx.fillRect(200, 110, 240, 280);
        ctx.fillStyle = "#5a3a1a"; // banner
        ctx.fillRect(220, 140, 200, 44);
        ctx.fillStyle = "#1d130b";
        // High-contrast bars so the on-device sharpness gate passes.
        for (let x = 232; x < 408; x += 16) ctx.fillRect(x, 320, 8, 48);
        ctx.font = "bold 26px serif";
        ctx.fillText("EAGLE RARE", 226, 230);
        ctx.font = "18px serif";
        ctx.fillText("10 YEARS OLD", 248, 264);
      };
      draw();
      setInterval(draw, 100); // identical pixels, but frames keep flowing
      const stream = canvas.captureStream(10);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => stream },
      });
    });
    await page.route("**/api/scan-label", (route) =>
      route.fulfill({
        json: {
          extracted: {
            brandGuess: "Eagle Rare",
            expressionGuess: "10 Year",
            ageStatement: "10 Year",
            proof: 90,
          },
          candidates: [
            {
              id: "eagle-rare-10",
              name: "Eagle Rare 10 Year",
              category: "bourbon",
              country: "USA",
              region: "Kentucky",
              ageYears: 10,
              abv: 45,
              msrp: 40,
              avgPrice: 55,
              distillery: "Buffalo Trace Distillery",
            },
          ],
        },
      }),
    );
    await page.goto("/scan");
    // Wait for the live viewfinder (the toggle enables once the camera is on).
    await expect(page.getByRole("button", { name: /turn off live label id/i })).toBeEnabled();
    // This suite pins Date.now(), which also freezes the live reader's
    // "quiet for 2.5s" gate — hop the fixed clock forward to open it
    // deterministically instead of sleeping.
    await page.clock.setFixedTime(new Date("2026-07-19T19:30:10Z"));
    await expect(page.getByRole("region", { name: "Live label match" })).toBeVisible({
      timeout: 20_000,
    });
    await settle(page);
    await expect(page).toHaveScreenshot(shot("scan-live"), { fullPage: true });
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
    // Scoped to main (the bottom nav's Friends tab matches too); .last() is
    // the mutual chip rather than the page h1.
    await expect(page.getByRole("main").getByText("Friends", { exact: true }).last()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("friends"), { fullPage: true });
  });

  test("add-confirm: Sasha's identity preview with the Following state", async ({ page }) => {
    await page.goto("/add/sasha");
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    // Scoped to main: the bottom nav's Friends tab also carries this text.
    await expect(page.getByRole("main").getByText("Friends", { exact: true })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("add-confirm"), { fullPage: true });
  });

  test("a friend's profile: palate, taste-twin match, signature descriptors, notes", async ({ page }) => {
    await page.goto("/u/sasha");
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    // US-16: Jordan follows Sasha and both palates carry enough rated pours.
    await expect(page.getByTestId("palate-match")).toBeVisible();
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

/** Signed in and not yet through the age gate (PLAN.md §9.1). */
test.describe("age gate", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!, GATE_SESSION_TOKEN);
  });

  test("the gate", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /one thing before we start/i })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("age-gate"), { fullPage: true });
  });
});
