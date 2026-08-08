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
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!);
  });

  test("home dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Welcome back/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ask your bar" })).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("home-dashboard"), { fullPage: true });
  });

  test("my bar", async ({ page }) => {
    await page.goto("/bar");
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: /For later today|This afternoon’s selection|Tonight’s pour|Tonight’s selection/,
      }),
    ).toBeVisible();
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
    await page.getByRole("tab", { name: "My palate" }).click();
    await expect(page.getByText("You lean toward")).toBeVisible();
    await settle(page);
    await expect(map).toHaveScreenshot(shot("bar-palate-map"));
  });

  test("tried tab: flavor map scoped to what you've tasted", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("tab", { name: "Tried" }).click();
    await expect(page.getByRole("tab", { name: "Only tasted" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-tried"), { fullPage: true });
  });

  test("wishlist tab", async ({ page }) => {
    await page.goto("/bar");
    await page.getByRole("tab", { name: /wishlist/i }).click();
    await expect(page.getByText(/Yamazaki/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-wishlist"), { fullPage: true });
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
});
