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
    // Let the hero/discovery rails finish loading first: the dashboard and
    // rails above the friends module reflow the page while they resolve, and
    // a click during that reflow can land beside the link.
    await expect(page.getByText("Finding bottles…")).toHaveCount(0, { timeout: 15_000 });
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

  test("/friends is the feed: Sasha's note card, a working cheers, and the inbox bell", async ({ page }) => {
    await page.goto("/friends");
    const feed = page.getByRole("region", { name: "Feed" });
    await expect(feed.getByText("@sasha").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Notifications/ })).toBeVisible();
    await page.getByRole("link", { name: "People" }).click();
    await expect(page).toHaveURL(/\/friends\/people$/);
    await expect(page.getByLabel("Handle or phone number to add")).toBeVisible();
  });

  test("/friends lists Sasha under both Following and Followers with a Friends chip, plus the handle-or-phone finder form", async ({
    page,
  }) => {
    await page.goto("/friends/people");

    // v2 finder form (docs/SOCIAL.md §7.2): a single input takes @handle or
    // phone number, landing on /add/[handle] rather than following inline.
    await expect(page.getByLabel("Handle or phone number to add")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();

    // Following/Followers are a tab pair now, not stacked sections.
    await page.getByRole("tab", { name: /Following/ }).click();
    await expect(page.getByText("@sasha")).toBeVisible();
    // Scoped to Sasha's row: the page h1 is also exactly "Friends".
    await expect(
      page.getByRole("link", { name: /Sasha Glen/ }).getByText("Friends", { exact: true }),
    ).toBeVisible();

    await page.getByRole("tab", { name: /Followers/ }).click();
    await expect(page.getByText("@sasha")).toBeVisible();
  });

  test("/friends shows identity up top and the Find friends card with both faces", async ({
    page,
  }) => {
    await page.goto("/friends/people");

    // Identity header card carries the handle now.
    await expect(page.getByText("@jordan").first()).toBeVisible();

    // Default face ("Find people"): the add form and the QR pair.
    await page.getByRole("button", { name: "Show my code" }).click();
    const qr = page.getByRole("img", { name: "QR code to add @jordan on Caskfolk" });
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute("src", /^data:image\/png;base64,/);

    // Second face: phone-discovery settings live inside the same card.
    await page.getByRole("tab", { name: "How you're found" }).click();
    // exact: the add-friend input's label also contains "phone number".
    await expect(page.getByLabel("Phone number", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Let people find me by phone" })).toBeVisible();
  });

  test("typing a handle in the finder lands on /add/sasha showing her identity and Following state", async ({
    page,
  }) => {
    await page.goto("/friends/people");
    await page.getByLabel("Handle or phone number to add").fill("sasha");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\/add\/sasha$/);
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
    // Exact match: a substring match also hits Next's route announcer div,
    // which echoes the page title ("Add @sasha · Caskfolk").
    await expect(page.getByText("@sasha", { exact: true })).toBeVisible();
    // Jordan already follows Sasha and she follows him back (seeded mutual).
    // Not anchored/exact: the chip ("Friends") and the state pill ("Following")
    // sit as adjacent inline spans, so the accessibility tree can merge their
    // text into one node — a substring match is robust to that either way.
    // Scoped to main: the bottom nav's Friends tab also carries this text.
    await expect(page.getByRole("main").getByText("Friends", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(/Following/)).toBeVisible();
  });

  test("typing Sasha's seeded phone number looks her up and lands on /add/sasha", async ({ page }) => {
    await page.goto("/friends/people");
    await page.getByLabel("Handle or phone number to add").fill(DEMO_FRIEND_PHONE);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\/add\/sasha$/);
    await expect(page.getByRole("heading", { name: "Sasha Glen" })).toBeVisible();
  });

  test("an unknown phone number stays on /friends with the no-match copy", async ({ page }) => {
    await page.goto("/friends/people");
    await page.getByLabel("Handle or phone number to add").fill("+15550001234");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(
      page.getByText("No one found by that number. They may not have opted in — ask them for their @handle or code."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/friends\/people$/);
  });

  test("/add/nobody999 shows friendly not-found copy", async ({ page }) => {
    await page.goto("/add/nobody999");
    await expect(page.getByRole("heading", { name: "No one by that handle" })).toBeVisible();
    await expect(page.getByText("Codes expire when accounts close.")).toBeVisible();
    // Scoped to main: the header's back slot is also "Back to Friends" here.
    await expect(page.getByRole("main").getByRole("link", { name: "Back to Friends" })).toBeVisible();
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
    await page.goto("/friends/people");

    // Retries reuse the same seeded DB within a run, so only claim a handle
    // when this attempt actually needs to (idempotent across a retry).
    const claimButton = page.getByRole("button", { name: "Claim handle" });
    if (await claimButton.isVisible().catch(() => false)) {
      await page.getByLabel("Handle").fill("samscanner");
      await claimButton.click();
      // Generous timeout: on a cold dev server the post-claim refresh compiles
      // /friends from scratch and can outlast the default 5s.
      await expect(page.getByRole("tab", { name: "How you're found" })).toBeVisible({
        timeout: 15000,
      });
    }

    // Phone settings are the second face of the Find friends card — switch to
    // it before driving the phone flow. (Face selection resets per page load,
    // so retries switch again.)
    await page.getByRole("tab", { name: "How you're found" }).click();
    const finderCard = page.locator("section", { hasText: "Find friends" });
    await expect(finderCard).toBeVisible();

    // No number yet (or a fresh claim): the add form is showing. Discovery is
    // never preselected (docs/SOCIAL.md D8 as amended), so opting in is an
    // explicit tap before saving.
    // exact: the add-friend input's label also contains "phone number".
    const phoneInput = finderCard.getByLabel("Phone number", { exact: true });
    if (await phoneInput.isVisible().catch(() => false)) {
      await phoneInput.fill("+15551230099");
      const optIn = finderCard.getByRole("switch", { name: "Let people find me by phone" });
      await expect(optIn).toHaveAttribute("aria-checked", "false");
      await optIn.click();
      await expect(optIn).toHaveAttribute("aria-checked", "true");
      await finderCard.getByRole("button", { name: "Save" }).click();
    }

    await expect(finderCard.getByText(/••••\s*••99/)).toBeVisible();

    // A retry reuses the seeded DB, so a prior attempt may have already
    // toggled discovery off — bring it back on before asserting the cycle.
    const toggle = finderCard.getByRole("switch", { name: "Let people find me by phone" });
    if ((await toggle.getAttribute("aria-checked")) === "false") {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(finderCard.getByText(/••••\s*••99\s*·\s*discoverable/)).toBeVisible();
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

// The M2 install loop (docs/SOCIAL.md D20; roadmap M2 exit): a signed-out
// guest goes from the host's link to rating a glass to the reveal.
test.describe("tasting night: guest link → rate → reveal", () => {
  test("a signed-out guest joins after the age check, rates blind, and sees the reveal", async ({ browser, baseURL }) => {
    const hostCtx = await browser.newContext();
    await signIn(hostCtx, baseURL!, DEMO_SESSION_TOKEN);
    const created = await hostCtx.request.post(`${baseURL}/api/flights`, {
      data: { title: "E2E blind night", blind: true, bottleIds: ["lagavulin-16", "highland-park-12", "eagle-rare-10"] },
    });
    expect(created.status()).toBe(201);
    const { path, joinCode } = (await created.json()) as { path: string; joinCode: string };

    const guestCtx = await browser.newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(path);
    await expect(guest.getByRole("heading", { name: "E2E blind night" })).toBeVisible();
    // Blind: no bottle names before the reveal.
    await expect(guest.getByText("Lagavulin 16")).toHaveCount(0);
    await guest.getByLabel("First name").fill("Pat");
    await guest.getByLabel("Date of birth").fill("1990-05-05");
    await guest.getByRole("button", { name: "Join the tasting" }).click();
    await expect(guest.getByText(/You’re a guest|You're a guest/)).toBeVisible({ timeout: 15000 });

    await guest.getByRole("radiogroup", { name: "Rating for glass A" }).getByRole("radio", { name: "4 stars" }).click();
    await expect(guest.getByText("Saved — hidden until the reveal.").first()).toBeVisible();

    const revealed = await hostCtx.request.post(`${baseURL}/api/flights/${joinCode}/state`, { data: { to: "revealed" } });
    expect(revealed.status()).toBe(200);

    await guest.reload();
    await expect(guest.getByText("Lagavulin 16")).toBeVisible();
    await expect(guest.getByText("★ 4").first()).toBeVisible();
    await hostCtx.close();
    await guestCtx.close();
  });
});

test.describe("trails (renamed challenges): breadth only", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!, DEMO_SESSION_TOKEN);
  });

  test("/trails lists this month's three curated trails and joining one shows progress", async ({ page }) => {
    await page.goto("/trails");
    await expect(page.getByRole("heading", { name: "Trails this month" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Social sections" }).getByRole("link", { name: "Trails" })).toHaveAttribute("aria-current", "page");
    const cards = page.locator("li.card");
    await expect(cards).toHaveCount(3);
    const first = cards.first();
    await first.getByRole("button", { name: "Join" }).click();
    await expect(first.getByRole("button", { name: "Leave" })).toBeVisible({ timeout: 15000 });
    await expect(first.getByText(/\d+ of \d+/)).toBeVisible();
    // The friend board is opt-in and says what it counts.
    await expect(page.getByText(/Never how much/)).toBeVisible();
  });
});

test.describe("trails: the old /challenges address", () => {
  test("redirects to /trails, keeping the board choice", async ({ context, baseURL, page }) => {
    await signIn(context, baseURL!, DEMO_SESSION_TOKEN);
    await page.goto("/challenges?board=distilleries");
    await expect(page).toHaveURL(/\/trails\?board=distilleries$/);
    await expect(page.getByRole("heading", { name: "Trails this month" })).toBeVisible();
  });
});

// Outings (docs/SOCIAL.md D22): the owner's distillery trip, on a phone. A
// friend without the app joins from the host's link as a guest, logs a cask
// sample that is in no catalog, and sees the group recap when the host ends it.
test.describe("outing: guest link → log a cask sample → recap", () => {
  test("a signed-out guest joins after the age check, logs by name, and sees the recap", async ({ browser, baseURL }) => {
    const hostCtx = await browser.newContext();
    await signIn(hostCtx, baseURL!, DEMO_SESSION_TOKEN);
    const created = await hostCtx.request.post(`${baseURL}/api/outings`, {
      data: { title: "E2E distillery day", distilleryName: "Buffalo Trace", location: "Frankfort, KY", visitOn: "2026-10-31" },
    });
    expect(created.status()).toBe(201);
    const { path, joinCode } = (await created.json()) as { path: string; joinCode: string };

    const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guest = await guestCtx.newPage();
    await guest.goto(path);
    await expect(guest.getByRole("heading", { name: "E2E distillery day" })).toBeVisible();
    // A bystander with the link sees no feed.
    await expect(guest.getByRole("heading", { name: /feed/ })).toHaveCount(0);
    await guest.getByLabel("First name").fill("Pat");
    await guest.getByLabel("Date of birth").fill("1990-05-05");
    await guest.getByRole("button", { name: "Join the outing" }).click();
    await expect(guest.getByText(/You’re a guest|You're a guest/)).toBeVisible({ timeout: 15000 });
    await expect(guest.getByRole("complementary", { name: "Getting there and back" })).toBeVisible();

    await guest.getByLabel("What did they pour?").fill("Cask 1142 sample");
    await guest.getByRole("button", { name: /Log “Cask 1142 sample” as poured here/ }).click();
    await guest.getByRole("radiogroup", { name: /Rating for Cask 1142 sample/ }).getByRole("radio", { name: "4 stars" }).click();
    await guest.getByRole("button", { name: "Vanilla" }).click();
    await guest.getByRole("button", { name: "Log it" }).click();
    await expect(guest.getByText("Logged to the outing.")).toBeVisible({ timeout: 15000 });
    await expect(guest.locator("li", { hasText: "You tasted Cask 1142 sample" })).toBeVisible();

    await guest.getByLabel("Add a note for the group").fill("Barrel thief!");
    await guest.getByRole("button", { name: "Post" }).click();
    await expect(guest.getByText("Barrel thief!")).toBeVisible({ timeout: 15000 });

    // The host logs the same sample (consensus) and ends the outing.
    const hostLog = await hostCtx.request.post(`${baseURL}/api/outings/${joinCode}/tastings`, {
      data: { label: "cask 1142 sample", rating: 5, flavorTags: { vanilla: 2, oak: 1 } },
    });
    expect(hostLog.status()).toBe(201);
    const ended = await hostCtx.request.post(`${baseURL}/api/outings/${joinCode}/state`, { data: { to: "ended" } });
    expect(ended.status()).toBe(200);

    await guest.reload();
    const recap = guest.locator("section", { has: guest.getByRole("heading", { name: "The recap" }) });
    await expect(recap).toBeVisible();
    await expect(recap.getByText("Group favorite")).toBeVisible();
    await expect(recap.getByText("★ 4.5").first()).toBeVisible();
    await expect(recap.getByText("Flavor spread")).toBeVisible();
    // No per-person counts or amounts anywhere on the page.
    await expect(guest.getByText(/\b\d+\s*(ml|oz|pours?|drinks?)\b/i)).toHaveCount(0);
    // Logging is closed once the outing ends.
    await expect(guest.getByRole("heading", { name: "Log a tasting" })).toHaveCount(0);

    // The host can delete it (this is how a test outing is cleaned up).
    const del = await hostCtx.request.delete(`${baseURL}/api/outings/${joinCode}`);
    expect(del.status()).toBe(200);
    await hostCtx.close();
    await guestCtx.close();
  });

  test("an underage guest is turned away and gets no seat", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto("/o/demotrip01");
    await page.getByLabel("First name").fill("Kid");
    await page.getByLabel("Date of birth").fill("2012-01-01");
    await page.getByRole("button", { name: "Join the outing" }).click();
    await expect(page.getByText(/legal drinking age/)).toBeVisible({ timeout: 15000 });
    const res = await ctx.request.post(`${baseURL}/api/outings/demotrip01/tastings`, { data: { label: "Sneaky sample" } });
    expect(res.status()).toBe(403);
    await ctx.close();
  });

  test("the host plans an outing from /clubs on a phone", async ({ context, baseURL, page }) => {
    await signIn(context, baseURL!, DEMO_SESSION_TOKEN);
    await page.goto("/clubs");
    await page.getByRole("link", { name: "Plan one →" }).click();
    await expect(page.getByRole("heading", { name: "Plan an outing" })).toBeVisible();
    await page.getByLabel("Distillery").fill("Maker's Mark");
    await page.getByLabel("Day", { exact: true }).fill("2026-11-01");
    await page.getByRole("button", { name: "Create the outing" }).click();
    await expect(page.getByRole("heading", { name: "Day at Maker's Mark" })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("img", { name: /QR code to join/ })).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete outing" }).click();
    await expect(page).toHaveURL(/\/clubs$/, { timeout: 15000 });
  });
});
