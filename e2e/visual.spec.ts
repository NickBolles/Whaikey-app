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
});

test.describe("signed in (demo collector)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!);
  });

  test("home dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Welcome back/i)).toBeVisible();
    // Wait for the recommendation rails to resolve (match chips render on
    // loaded cards) so the palate-driven content is captured, not a skeleton.
    await expect(page.getByRole("heading", { name: "What to pour tonight" })).toBeVisible();
    await expect(page.getByText(/% match/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("home-dashboard"), { fullPage: true });
  });

  test("my bar", async ({ page }) => {
    await page.goto("/bar");
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(shot("bar-own"), { fullPage: true });
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
    // Expand the optional tasting-notes section to reveal freeform + voice
    // capture (the AI-assisted note-capture surface).
    await page.getByRole("button", { name: /Tasting notes/i }).click();
    await expect(page.getByRole("button", { name: /Auto-fill|Extract/i })).toBeVisible();
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
});
