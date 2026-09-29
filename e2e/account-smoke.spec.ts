import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { ACCOUNT_SESSION_TOKEN, LEAVING_SESSION_TOKEN, signIn } from "./fixtures";

/**
 * Settings, end to end (WP-11; review UX-4, SEC-M5): the three account
 * actions that were impossible before — sign out, export, delete — each
 * walked through the real page, the real route and a real browser download.
 *
 * Named `*-smoke.spec.ts` so the functional project's `(smoke|social)` match
 * picks it up. The two accounts are seeded by e2e/account-seed.ts and are
 * used up here: signing out deletes the first one's session and the second
 * one is deleted outright.
 */
test.describe("settings: sign out, export and delete", () => {
  test("/sharing lands on Settings, and the owner's profile leads there too", async ({ context, baseURL, page }) => {
    await signIn(context, baseURL!);
    await page.goto("/sharing");
    await expect(page).toHaveURL(/\/settings#sharing$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shared links" })).toBeVisible();

    await page.goto("/u/jordan");
    await page.getByRole("navigation", { name: "Sharing and settings" }).getByRole("link", { name: /^settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("export downloads the account's own data as JSON and CSV, then sign-out ends the session", async ({
    context,
    baseURL,
    page,
  }) => {
    await signIn(context, baseURL!, ACCOUNT_SESSION_TOKEN);
    await page.goto("/settings");
    await expect(page.getByText("account-user@whaikey.app")).toBeVisible();

    const [json] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: /download json/i }).click(),
    ]);
    expect(json.suggestedFilename()).toMatch(/^whaikey-export-\d{4}-\d{2}-\d{2}\.json$/);
    const exported = JSON.parse(fs.readFileSync((await json.path())!, "utf8"));
    expect(exported.format).toBe("whaikey-account-export");
    expect(exported.data.account[0].email).toBe("account-user@whaikey.app");
    expect(exported.data.tasting_notes).toEqual([
      expect.objectContaining({ freeform: "Export me: toffee and orange peel" }),
    ]);
    // Somebody else's account shares the database; none of it is in here.
    expect(JSON.stringify(exported)).not.toContain("Delete me: smoke and brine");
    expect(JSON.stringify(exported)).not.toContain("e2e-account-session-token");

    const [zip] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: /download csv/i }).click(),
    ]);
    expect(zip.suggestedFilename()).toMatch(/^whaikey-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const bytes = fs.readFileSync((await zip.path())!);
    // A zip's local-file-header signature, "PK\x03\x04".
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    // Not just a signed-out-looking page: the server no longer knows the session.
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    await page.goto("/settings");
    await expect(page.getByText(/sign in to manage your account/i)).toBeVisible();
  });

  test("deleting the account needs the typed word, then removes it and signs out", async ({
    context,
    baseURL,
    page,
  }) => {
    await signIn(context, baseURL!, LEAVING_SESSION_TOKEN);
    await page.goto("/settings");
    await page.getByRole("button", { name: /delete account/i }).click();

    const dialog = page.getByRole("alertdialog", { name: /delete your account/i });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete my account" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/type delete to confirm/i).fill("DELETE");
    await confirm.click();

    await expect(page).toHaveURL(new RegExp(`^${baseURL}/?$`));
    // The cookie is cleared; put the old one back and it opens nothing.
    await signIn(context, baseURL!, LEAVING_SESSION_TOKEN);
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    await page.goto("/settings");
    await expect(page.getByText(/sign in to manage your account/i)).toBeVisible();
  });
});
