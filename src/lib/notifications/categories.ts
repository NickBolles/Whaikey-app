/**
 * The notification category contract.
 *
 * This list is the shared vocabulary between the settings UI, the per-device
 * overrides stored as jsonb, and every call site that sends something. Ids are
 * persisted in `notification_preferences.categories` and
 * `push_devices.category_overrides`, so **do not rename them** — add a new id
 * and migrate instead.
 *
 * The set is deliberately closed. PLAN.md §7's responsible-drinking stance
 * rules out anything that rewards consumption frequency, so there is no "time
 * for a dram", no streak, no "you haven't poured in a while". Every category
 * here is either something the user asked to watch, something they scheduled,
 * or something about the security of their account. If a future feature wants
 * to nudge, it needs a product decision, not a new entry in this file.
 */

export interface NotificationCategory {
  id: string;
  label: string;
  /** One line, shown under the toggle. Written for the person, not the dev. */
  description: string;
  /** Applied when neither the account nor the device has an opinion. */
  defaultEnabled: boolean;
  /**
   * Critical categories ignore quiet hours and the per-category account toggle
   * cannot be turned off — a sign-in from a new device is not something we hold
   * until 08:00, and silently dropping it would be a security footgun. They can
   * still be silenced per device, because a device you no longer use should not
   * keep buzzing.
   */
  critical?: boolean;
}

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  {
    id: "price_alert",
    label: "Wishlist price alerts",
    description: "A bottle on your wishlist drops below the price you set.",
    defaultEnabled: true,
  },
  {
    id: "tasting_invite",
    label: "Blind tasting invites",
    description: "Someone invites you to a blind tasting, or a reveal is ready.",
    defaultEnabled: true,
  },
  {
    id: "catalog_verification",
    label: "Catalog corrections",
    description: "A bottle on your shelf was corrected or verified in the catalog.",
    defaultEnabled: false,
  },
  {
    id: "wrapped",
    label: "Your year in whiskey",
    description: "Once a year, when your Wrapped is ready.",
    defaultEnabled: true,
  },
  {
    id: "account",
    label: "Account & security",
    description: "New sign-ins and changes to your account. Always delivered.",
    defaultEnabled: true,
    critical: true,
  },
] as const;

export type NotificationCategoryId = (typeof NOTIFICATION_CATEGORIES)[number]["id"];

const BY_ID = new Map(NOTIFICATION_CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: string): NotificationCategory | undefined {
  return BY_ID.get(id);
}

export function isKnownCategory(id: string): boolean {
  return BY_ID.has(id);
}

/** Category defaults as a plain map — the base layer of settings resolution. */
export function defaultCategoryMap(): Record<string, boolean> {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.id, c.defaultEnabled]));
}

/**
 * A test send belongs to no product category: it is the user asking "does this
 * device work at all", so it bypasses category filtering (never quiet hours —
 * a test that ignores quiet hours would prove the wrong thing, and the UI says
 * so instead of lying about delivery).
 */
export const TEST_CATEGORY_ID = "test";
