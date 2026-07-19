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

test.describe("whiskey school", () => {
  test("hub lists both tracks and their lessons", async ({ page }) => {
    await page.goto("/learn");
    await expect(page.getByRole("heading", { name: /Learn whiskey/i })).toBeVisible();
    await expect(page.getByText("Whiskey 101").first()).toBeVisible();
    await expect(page.getByText("Going deeper").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /What is whiskey, anyway/i })).toBeVisible();
  });

  test("lesson page renders content and the quiz gives feedback", async ({ page }) => {
    await page.goto("/learn/what-is-whiskey");
    await expect(page.getByRole("heading", { name: /What is whiskey, anyway/i })).toBeVisible();
    await expect(page.getByText(/Key terms/i)).toBeVisible();

    await page.getByRole("button", { name: "Cereal grain" }).click();
    await expect(page.getByText(/Correct\. Grain is the defining ingredient/i)).toBeVisible();
  });

  test("finishing a quiz marks the lesson done on the hub", async ({ page }) => {
    await page.goto("/learn/what-is-whiskey");
    await page.getByRole("button", { name: "Cereal grain" }).click();
    await page.getByRole("button", { name: "The oak cask" }).click();
    await page.getByRole("button", { name: "Spirit straight off the still, before aging" }).click();
    await expect(page.getByText("3/3", { exact: true })).toBeVisible();

    await page.goto("/learn");
    const lessonLink = page.getByRole("link", { name: /What is whiskey, anyway/i });
    await expect(lessonLink.getByText("Done")).toBeVisible();
  });

  test("unknown lesson slugs 404", async ({ page }) => {
    const response = await page.goto("/learn/not-a-lesson");
    expect(response?.status()).toBe(404);
  });

  test("flavor explorer shows a family's education card on tap", async ({ page }) => {
    await page.goto("/learn/flavors");
    await expect(page.getByRole("heading", { name: "The flavor wheel" })).toBeVisible();

    await page.getByRole("button", { name: "Sweet" }).click();
    await expect(page.getByText(/Where it comes from/i)).toBeVisible();
    await expect(page.getByText("Butterscotch")).toBeVisible();
  });
});
