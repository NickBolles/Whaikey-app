import { expect, test } from "@playwright/test";
import { SCAN_SESSION_TOKEN, signIn } from "./fixtures";

test.describe("signed-out smoke", () => {
  test("home shows the hero with a sign-in CTA", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Whaikey" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Get started" })).toBeVisible();
  });

  test("sign-in page offers social providers only", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Apple/i })).toBeVisible();
    await expect(page.locator("input[type=password]")).toHaveCount(0);
  });

  test("search works without an account", async ({ page }) => {
    await page.goto("/search");
    const input = page.getByRole("searchbox");
    await input.first().fill("eagle rare");
    await expect(page.getByText(/Eagle Rare/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("bottle detail renders from a search result", async ({ page }) => {
    await page.goto("/search");
    await page.getByRole("searchbox").first().fill("lagavulin 16");
    const result = page.getByText(/Lagavulin 16/i).first();
    await result.click();
    await expect(page).toHaveURL(/\/bottles\//);
    await expect(page.getByText(/Lagavulin/i).first()).toBeVisible();
  });

  test("bottom nav is present with all six tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "Search", "Scan", "My Bar", "Pour", "Chat"]) {
      await expect(nav.getByText(label)).toBeVisible();
    }
  });
});

test.describe("signed-in scan flow", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!, SCAN_SESSION_TOKEN);
  });

  test("rapid barcode entry shelves bottles one after another", async ({ page }) => {
    await page.goto("/scan");
    // Headless has no camera, so the manual fallback is the deterministic path.
    const input = page.getByLabel(/barcode number/i);
    await expect(input).toBeVisible();

    await input.fill("080244009960"); // seeded: Buffalo Trace
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("status")).toContainText(/Added Buffalo Trace/i);
    await expect(page.getByText(/Scanned this session \(1\)/i)).toBeVisible();

    await input.fill("096749001613"); // seeded: Elijah Craig Small Batch
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByText(/Scanned this session \(2\)/i)).toBeVisible();

    await page.goto("/bar");
    await expect(page.getByText(/Buffalo Trace/i).first()).toBeVisible();
    await expect(page.getByText(/Elijah Craig Small Batch/i).first()).toBeVisible();
  });

  test("an unknown barcode can be taught via catalog search", async ({ page }) => {
    await page.goto("/scan");
    const input = page.getByLabel(/barcode number/i);
    await input.fill("012345678905"); // valid check digit, not in the catalog
    await page.getByRole("button", { name: "Scan" }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(/new one on us/i);
    await sheet.getByRole("searchbox").fill("glenfarclas 105");
    await sheet.getByRole("button", { name: /this one/i }).first().click();
    await expect(page.getByText(/Scanned this session \(1\)/i)).toBeVisible();

    // The confirmation crowdsourced the mapping: scanning again resolves instantly.
    await input.fill("012345678905");
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("status")).toContainText(/already scanned/i);
  });

  test("a bad code gets a clear inline error", async ({ page }) => {
    await page.goto("/scan");
    await page.getByLabel(/barcode number/i).fill("1234");
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("alert")).toContainText(/doesn't look like/i);
  });
});
