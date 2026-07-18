import { expect, test } from "@playwright/test";

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

  test("bottom nav is present with all five tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "Search", "My Bar", "Pour", "Chat"]) {
      await expect(nav.getByText(label)).toBeVisible();
    }
  });
});
