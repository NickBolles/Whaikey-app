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

  // The visual baselines cannot police this. Three 19px crests are ~0.4% of a
  // 390x844 page, well under the suite's 2% maxDiffPixelRatio, so a shot of a
  // list that silently lost its stamps still passes. Assert the count.
  test("a bottle's passport stamps ride its detail page and its search card", async ({ page }) => {
    await page.goto("/search");
    await page.getByRole("searchbox").first().fill("lagavulin 16");
    const card = page.locator("a[href^='/bottles/']").first();
    await expect(card).toBeVisible();
    // Country, region, style — decorative, so the origin is not read twice.
    await expect(card.locator("[aria-hidden='true'] svg")).toHaveCount(3);

    await card.click();
    await expect(page).toHaveURL(/\/bottles\//);
    const hero = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
    await expect(hero.locator("[aria-hidden='true'] svg")).toHaveCount(3);
  });

  test("bottom nav keeps destinations focused and exposes quick actions", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "My Bar", "Friends", "Chat"]) {
      await expect(nav.getByText(label)).toBeVisible();
    }
    await nav.getByRole("button", { name: "Open quick actions" }).click();
    await expect(page.getByRole("link", { name: /Log a pour/i })).toHaveAttribute("href", "/pour");
    await expect(page.getByRole("link", { name: /Scan a bottle/i })).toHaveAttribute("href", "/scan");
  });
});

test.describe("signed-in scan flow", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!, SCAN_SESSION_TOKEN);
  });

  test("a bottle-linked pour starts at the tasting form and can be changed", async ({ page }) => {
    await page.goto("/pour?bottleId=eagle-rare-10");
    await expect(page.getByText("Eagle Rare 10 Year")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Rating" })).toBeVisible();
    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.getByPlaceholder("What are you pouring?")).toBeVisible();
  });

  test("rapid barcode entry shelves bottles one after another", async ({ page }) => {
    await page.goto("/scan");
    // Headless has no camera, so the manual fallback is the deterministic path.
    const input = page.getByLabel(/barcode number/i);
    await expect(input).toBeVisible();

    await input.fill("080244009960"); // seeded: Buffalo Trace
    await page.getByRole("button", { name: "Scan" }).click();
    // Filtered: a lingering "Starting camera…" status can coexist under load,
    // and bare getByRole("status") strict-mode-collides with it.
    await expect(page.getByRole("status").filter({ hasText: /Added/i })).toContainText(/Added Buffalo Trace/i);
    await expect(page.getByText(/Scanned this session \(1\)/i)).toBeVisible();

    await input.fill("096749001613"); // seeded: Elijah Craig Small Batch
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByText(/Scanned this session \(2\)/i)).toBeVisible();

    await page.goto("/bar");
    await expect(page.getByText(/Buffalo Trace/i).first()).toBeVisible();
    await expect(page.getByText(/Elijah Craig Small Batch/i).first()).toBeVisible();
  });

  test("scanning and logging a pour are reachable from each other", async ({ page }) => {
    // Out from the pour flow...
    await page.goto("/pour");
    await page.getByRole("link", { name: /scan the bottle/i }).click();
    await expect(page.getByRole("heading", { name: /scan what you're pouring/i })).toBeVisible();

    // ...identify the bottle in hand. Its own UPC, so the tests above cannot
    // leave it already shelved and change the wording of this one's toast.
    await page.getByLabel(/barcode number/i).fill("085246000014"); // seeded: Maker's Mark
    await page.getByRole("button", { name: "Scan" }).click();
    await expect(page.getByRole("status")).toContainText(/Added Maker's Mark/i);

    // ...and back into the pour flow with that bottle already chosen.
    await page.getByRole("link", { name: "Pour" }).click();
    await expect(page.getByRole("heading", { name: "Rating" })).toBeVisible();
    await expect(page.getByText(/Maker's Mark/i).first()).toBeVisible();
  });

  test("a pour shelves an unfiled bottle so it shows up under Tried", async ({ page }) => {
    await page.goto("/pour?bottleId=glenfarclas-105");
    await page.getByRole("button", { name: "Save pour" }).click();
    await expect(page.getByRole("heading", { name: "Poured." })).toBeVisible();

    await page.goto("/bar");
    // Tried is a quick pick on the filter line.
    await page.getByRole("button", { name: "Tried", exact: true }).click();
    await expect(page.getByText(/Glenfarclas 105/i).first()).toBeVisible();
  });

  test("an unknown barcode can be taught via catalog search", async ({ page }) => {
    await page.goto("/scan");
    const input = page.getByLabel(/barcode number/i);
    await input.fill("012345678905"); // valid check digit, not in the catalog
    await page.getByRole("button", { name: "Scan" }).click();

    // The miss queues up as a needs-you item instead of blocking the flow.
    await page.getByRole("button", { name: /needs you/i }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(/new one on us/i);
    await sheet.getByRole("searchbox").fill("glenfarclas 105");
    await sheet.getByRole("button", { name: /^this one$/i }).first().click();
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
    await expect(page.getByText(/doesn't look like a UPC/i)).toBeVisible();
  });

  test("spreadsheet import: paste → map → match → commit lands in the bar", async ({ page }) => {
    await page.goto("/import");
    await page
      .getByLabel(/paste csv/i)
      .fill(
        "Bottle,UPC,Price Paid\nRittenhouse Bottled in Bond,096749001101,27.99\nLarceny Small Batch,,19.99",
      );
    await page.getByRole("button", { name: /continue/i }).click();

    // Column mapping proposed (heuristics — no AI key in e2e) and confirmed as-is.
    await expect(page.getByText(/column mapping/i)).toBeVisible();
    await page.getByRole("button", { name: /match 2 rows/i }).click();

    // Row 1 resolves via the seeded UPC, row 2 via fuzzy name.
    await expect(page.getByText(/confirm matches \(2\/2\)/i)).toBeVisible();
    await expect(page.getByText(/via upc/i)).toBeVisible();
    await page.getByRole("button", { name: /import 2 bottles/i }).click();
    await expect(page.getByText(/collection imported/i)).toBeVisible();

    await page.goto("/bar");
    await expect(page.getByText(/Rittenhouse/i).first()).toBeVisible();
    await expect(page.getByText(/Larceny Small Batch/i).first()).toBeVisible();
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

/**
 * The reported bug lives in the browser's own touch pipeline: the page scrolled
 * out from under the wheel, so a held sweep never landed. jsdom cannot see that
 * — only a real touch on a real scrollable page can.
 */
test.describe("flavor wheel touch gesture", () => {
  test.use({ hasTouch: true });

  test("a held sweep tags a flavor and the page holds still, while a plain swipe still scrolls", async ({
    context,
    page,
    baseURL,
  }) => {
    await signIn(context, baseURL!, SCAN_SESSION_TOKEN);
    await page.goto("/pour?bottleId=eagle-rare-10");

    const wheel = page.getByRole("application", { name: "Flavor wheel" });
    await wheel.scrollIntoViewIfNeeded();
    const box = (await wheel.boundingBox())!;
    const unit = box.width / 340; // the wheel's viewBox is 340 wide
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Straight down the six o'clock line: from a family in the inner ring out
    // through the descriptor ring. Purely vertical — the same motion as a
    // scroll, which is exactly what used to make this gesture impossible.
    const from = { x: cx, y: cy + 85 * unit };

    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: point ? [{ x: point.x, y: point.y }] : [],
      });

    const chips = page.getByRole("list", { name: "Selected flavors" });

    // A swipe with no hold belongs to the page.
    await page.evaluate(() => window.scrollTo(0, 0));
    await touch("touchStart", from);
    for (let step = 1; step <= 6; step += 1) {
      await touch("touchMove", { x: from.x, y: from.y - step * 18 });
    }
    await touch("touchEnd");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(chips).toHaveCount(0);

    // Hold first, and the wheel takes the touch over: the sweep registers and
    // the page stays exactly where it was.
    await wheel.scrollIntoViewIfNeeded();
    const held = (await wheel.boundingBox())!;
    const holdFrom = { x: held.x + held.width / 2, y: held.y + held.height / 2 + 85 * unit };
    const holdTo = { x: holdFrom.x, y: held.y + held.height / 2 + 155 * unit };
    const before = await page.evaluate(() => window.scrollY);

    await touch("touchStart", holdFrom);
    await page.waitForTimeout(400);
    for (let step = 1; step <= 6; step += 1) {
      await touch("touchMove", {
        x: holdFrom.x,
        y: holdFrom.y + ((holdTo.y - holdFrom.y) * step) / 6,
      });
    }
    await touch("touchEnd");

    await expect(chips.getByRole("button")).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });
});
