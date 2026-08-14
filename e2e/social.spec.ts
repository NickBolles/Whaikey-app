import { expect, test } from "@playwright/test";
import { DEMO_FRIEND_PHONE } from "./demo-seed";
import { DEMO_SESSION_TOKEN, SCAN_SESSION_TOKEN, signIn } from "./fixtures";

// Deterministic ids from e2e/demo-seed.ts (docs/SOCIAL.md fixture block) —
// Sasha Glen (@sasha, demo-friend) is a mutual friend of Jordan (@jordan,
// the demo user), with a "friends"-visible lagavulin-16 pour that has a
// public share link, a cheers from Jordan, and a two-message comment thread;
// plus a second "friends"-visible highland-park-12 pour Jordan has never
// tried, for the Home discovery card.
const SASHA_LAGAVULIN_POUR_ID = "demo-friend-pour-1";
const SASHA_HIGHLAND_PARK_POUR_ID = "demo-friend-pour-2";
const SASHA_SHARE_CODE = "sashalagav16";
const SASHA_COMMENT_TEXT = /Funny how much iodine hit me/;
const JORDAN_REPLY_TEXT = /raisin and chocolate dominated/;

test.describe("social: signed in as Jordan (the demo user)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!, DEMO_SESSION_TOKEN);
  });

  test("home's From your friends module shows Sasha's comparison and discovery cards", async ({ page }) => {
    await page.goto("/");
    const friendsModule = page.getByRole("region", { name: "From your friends" });
    await expect(friendsModule).toBeVisible();

    // Comparison card: Jordan already has notes on lagavulin-16, so the CTA
    // reads "Compare notes" and the comparison sentence names shared/only-hers descriptors.
    const comparisonCard = friendsModule.locator("li", { hasText: "Lagavulin 16" });
    await expect(comparisonCard.getByText("@sasha")).toBeVisible();
    await expect(comparisonCard.getByRole("link", { name: /Compare notes/ })).toHaveAttribute(
      "href",
      `/notes/${SASHA_LAGAVULIN_POUR_ID}`,
    );

    // Discovery card: Jordan has never tried highland-park-12, so the CTA reads "See the note".
    const discoveryCard = friendsModule.locator("li", { hasText: "Highland Park 12" });
    await expect(discoveryCard.getByText("@sasha")).toBeVisible();
    await expect(discoveryCard.getByRole("link", { name: /See the note/ })).toHaveAttribute(
      "href",
      `/notes/${SASHA_HIGHLAND_PARK_POUR_ID}`,
    );
  });

  test("Compare notes navigates from Home into Sasha's note detail", async ({ page }) => {
    await page.goto("/");
    const friendsModule = page.getByRole("region", { name: "From your friends" });
    await friendsModule.getByRole("link", { name: /Compare notes/ }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${SASHA_LAGAVULIN_POUR_ID}$`));
    await expect(page.getByRole("link", { name: "Lagavulin 16" })).toBeVisible();
  });

  test("note detail renders Sasha's note, the three-way comparison, cheers count, and the seeded comment thread", async ({
    page,
  }) => {
    await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);

    // Author + note content.
    await expect(page.getByText("@sasha")).toBeVisible();
    await expect(page.getByText(/Peat and iodine up front/)).toBeVisible();

    // Comparison groups: Jordan and Sasha overlap on campfire/brine, diverge
    // on raisin/chocolate/medicinal (Jordan-only) vs peat/ash (Sasha-only).
    await expect(page.getByRole("heading", { name: /You both got/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /They got.*you didn.t/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /You got.*they didn.t/ })).toBeVisible();

    // Cheers count reflects Jordan's seeded cheer.
    const cheersButton = page.getByRole("button", { name: /Cheers/ });
    await expect(cheersButton).toHaveAttribute("aria-pressed", "true");
    await expect(cheersButton).toContainText("1");

    // Seeded comment thread: Sasha's comment and Jordan's threaded reply.
    await expect(page.getByText(SASHA_COMMENT_TEXT)).toBeVisible();
    await expect(page.getByText(JORDAN_REPLY_TEXT)).toBeVisible();
  });

  test("posting a comment appends it to the thread", async ({ page }) => {
    await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);

    // Unique per run so re-runs against the same seeded DB don't collide and
    // assertions never depend on an exact thread length.
    const commentText = `e2e social spec comment ${Date.now()}`;
    await page.getByPlaceholder("Add a comment…").fill(commentText);
    await page.getByRole("button", { name: /^Post$/ }).click();

    await expect(page.getByText(commentText)).toBeVisible();
    // The seeded thread is still there alongside the new comment.
    await expect(page.getByText(SASHA_COMMENT_TEXT)).toBeVisible();
  });

  test("cheers toggles off and back on, ending at the seeded count", async ({ page }) => {
    await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);
    const cheersButton = page.getByRole("button", { name: /Cheers/ });

    // Seeded state: Jordan has already cheered.
    await expect(cheersButton).toHaveAttribute("aria-pressed", "true");
    await expect(cheersButton).toContainText("1");

    await cheersButton.click();
    await expect(cheersButton).toHaveAttribute("aria-pressed", "false");
    await expect(cheersButton).toContainText("0");

    await cheersButton.click();
    await expect(cheersButton).toHaveAttribute("aria-pressed", "true");
    await expect(cheersButton).toContainText("1");
  });

  test("/friends lists Sasha under both Following and Followers with a Friends chip, plus the handle-or-phone finder form", async ({
    page,
  }) => {
    await page.goto("/friends");

    // v2 finder form (docs/SOCIAL.md §7.2): a single input takes @handle or
    // phone number, landing on /add/[handle] rather than following inline.
    await expect(page.getByLabel("Handle or phone number to add")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();

    const followingSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Following", exact: true }),
    });
    await expect(followingSection.getByText("@sasha")).toBeVisible();
    await expect(followingSection.getByText("Friends", { exact: true })).toBeVisible();

    const followersSection = page.locator("section", {
      has: page.getByRole("heading", { name: "Followers", exact: true }),
    });
    await expect(followersSection.getByText("@sasha")).toBeVisible();
  });

  test("/friends' How friends find you card shows the handle, a phone section, and Show my code reveals a QR", async ({
    page,
  }) => {
    await page.goto("/friends");

    const finderCard = page.locator("section", { hasText: "How friends find you" });
    await expect(finderCard.getByText("@jordan")).toBeVisible();
    await expect(finderCard.getByText(/Phone number/)).toBeVisible();

    await finderCard.getByRole("button", { name: "Show my code" }).click();
    const qr = finderCard.getByRole("img", { name: "QR code to add @jordan on Whaikey" });
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/);
  });

  test("typing a handle in the finder lands on /add/sasha showing her identity and Following state", async ({
    page,
  }) => {
    await page.goto("/friends");
    await page.getByLabel("Handle or phone number to add").fill("sasha");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\/add\/sasha$/);
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    // Exact match: a substring match also hits Next's route announcer div,
    // which echoes the page title ("Add @sasha · Whaikey").
    await expect(page.getByText("@sasha", { exact: true })).toBeVisible();
    // Jordan already follows Sasha and she follows him back (seeded mutual).
    // Not anchored/exact: the chip ("Friends") and the state pill ("Following")
    // sit as adjacent inline spans, so the accessibility tree can merge their
    // text into one node — a substring match is robust to that either way.
    await expect(page.getByText("Friends", { exact: true })).toBeVisible();
    await expect(page.getByText(/Following/)).toBeVisible();
  });

  test("typing Sasha's seeded phone number looks her up and lands on /add/sasha", async ({ page }) => {
    await page.goto("/friends");
    await page.getByLabel("Handle or phone number to add").fill(DEMO_FRIEND_PHONE);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\/add\/sasha$/);
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
  });

  test("an unknown phone number stays on /friends with the no-match copy", async ({ page }) => {
    await page.goto("/friends");
    await page.getByLabel("Handle or phone number to add").fill("+15550001234");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(
      page.getByText("No one found by that number. They may not have opted in — ask them for their @handle or code."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/friends$/);
  });

  test("/add/nobody999 shows friendly not-found copy", async ({ page }) => {
    await page.goto("/add/nobody999");
    await expect(page.getByRole("heading", { name: "No one by that handle" })).toBeVisible();
    await expect(page.getByText("Codes expire when accounts close.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Friends" })).toBeVisible();
  });

  test("/add/sasha shows no price data (money-leak guard)", async ({ page }) => {
    await page.goto("/add/sasha");
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("$");
  });

  test("/u/sasha renders her palate card and signature descriptors, shows Following state, and leaks no prices", async ({
    page,
  }) => {
    await page.goto("/u/sasha");

    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Flavor wheel heat map" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Signature descriptors" })).toBeVisible();

    // Mutual follow: Jordan already follows Sasha, and she follows him back.
    await expect(page.getByRole("button", { name: /Following/ })).toBeVisible();
    await expect(page.getByText("Follows you")).toBeVisible();

    // Money-leak guard (docs/SOCIAL.md: purchase price/value never cross a social boundary).
    await expect(page.locator("body")).not.toContainText("$");
  });

  test("no price data leaks onto the note detail or the public share page", async ({ page }) => {
    await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);
    await expect(page.locator("body")).not.toContainText("$");

    await page.goto(`/s/${SASHA_SHARE_CODE}`);
    await expect(page.locator("body")).not.toContainText("$");
  });

  test("/s/sashalagav16 signed in as a friend shows the comparison + discussion, but not link management", async ({
    page,
  }) => {
    await page.goto(`/s/${SASHA_SHARE_CODE}`);

    await expect(page.getByRole("heading", { name: "Lagavulin 16" })).toBeVisible();
    // Viewer-private comparison block (Jordan has his own lagavulin-16 note).
    await expect(page.getByRole("heading", { name: "You've tasted this too" })).toBeVisible();
    // Discussion block: the same cheers/comments surface as the note page.
    await expect(page.getByRole("button", { name: /Cheers/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

    // Jordan isn't the sharer (Sasha is), so link management must not show.
    await expect(page.getByText("manage shared links")).toHaveCount(0);
  });
});

test.describe("social: visibility enforcement for a non-friend", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // scan-user (see e2e/fixtures.ts) has no follow relationship with Sasha at all.
    await signIn(context, baseURL!, SCAN_SESSION_TOKEN);
  });

  test("a friends-visible note 404s for a signed-in non-friend", async ({ page }) => {
    const response = await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText(SASHA_COMMENT_TEXT)).toHaveCount(0);
  });

  test("Home's friends module never surfaces Sasha's pours for a non-friend", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("@sasha")).toHaveCount(0);
    await expect(page.getByText(/Lagavulin 16/)).toHaveCount(0);
  });
});

test.describe("social: signed-out visitor", () => {
  test("a friends-visible note shows the sign-in hero, never the content", async ({ page }) => {
    const response = await page.goto(`/notes/${SASHA_LAGAVULIN_POUR_ID}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "A tasting note awaits" })).toBeVisible();
    await expect(page.getByText(SASHA_COMMENT_TEXT)).toHaveCount(0);
  });

  test("the public share page still renders the card but no discussion", async ({ page }) => {
    await page.goto(`/s/${SASHA_SHARE_CODE}`);
    await expect(page.getByRole("heading", { name: "Lagavulin 16" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Comments" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Cheers/ })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("$");
  });

  test("/add/sasha shows the sign-in hero and leaks no identity", async ({ page }) => {
    const response = await page.goto("/add/sasha");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Add @sasha" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    // No identity leak: her display name must never render for a signed-out visitor.
    await expect(page.getByText("Sasha Glen")).toHaveCount(0);
  });
});

test.describe("social: phone discovery settings", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    // scan-user (see e2e/fixtures.ts) is the mutation-safe user — keeps
    // Jordan's seeded profile/phone state untouched for the other tests and
    // for the visual baselines. It has no profile yet, so the finder card
    // (phone settings included) only appears after claiming a handle.
    await signIn(context, baseURL!, SCAN_SESSION_TOKEN);
  });

  test("claiming a handle, then setting and toggling off a discoverable phone number", async ({ page }) => {
    await page.goto("/friends");

    // Retries reuse the same seeded DB within a run, so only claim a handle
    // when this attempt actually needs to (idempotent across a retry).
    const claimButton = page.getByRole("button", { name: "Claim handle" });
    if (await claimButton.isVisible().catch(() => false)) {
      await page.getByLabel("Handle").fill("samscanner");
      await claimButton.click();
      await expect(page.getByText("How friends find you")).toBeVisible();
    }

    const finderCard = page.locator("section", { hasText: "How friends find you" });
    await expect(finderCard).toBeVisible();

    // No number yet (or a fresh claim): the add form is showing.
    const phoneInput = finderCard.getByLabel("Phone number");
    if (await phoneInput.isVisible().catch(() => false)) {
      await phoneInput.fill("+15551230099");
      await finderCard.getByRole("button", { name: "Save" }).click();
    }

    await expect(finderCard.getByText(/••••\s*••99\s*·\s*discoverable/)).toBeVisible();

    const toggle = finderCard.getByRole("switch", { name: "Let people find me by phone" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(finderCard.getByText(/••••\s*••99\s*·\s*not discoverable/)).toBeVisible();
  });
});

// NOTE: docs/SOCIAL.md's revocation scenario (Sasha revokes the share link /
// unfriends Jordan and the surfaces update) could not be scripted here.
// e2e/demo-seed.ts mints a Better Auth session row only for DEMO_USER_ID and
// SCAN_USER_ID (see e2e/fixtures.ts DEMO_SESSION_TOKEN / SCAN_SESSION_TOKEN);
// demo-friend (Sasha) has no session row, and this spec is restricted to
// editing e2e/social.spec.ts + e2e/fixtures.ts, not e2e/demo-seed.ts, so an
// as-Sasha session cannot be minted. Revocation is exercised at the unit/API
// level instead (see src/app/api/pours/[id]/share/share-api.test.ts and
// src/app/api/social/follows/**/*.test.ts).
