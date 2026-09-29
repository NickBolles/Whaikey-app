/**
 * The app shell's view of the route map (docs/STORYBOARD.md §1.1): which
 * routes are tabs, which carry no chrome at all, what a route is called when
 * a back button names it, and where "back" goes when there is no in-app
 * history to go back through.
 *
 * Pure functions on a pathname, so the header, the nav and their tests all
 * read one table instead of three copies drifting apart.
 */

/**
 * The bottom-nav destinations, in slot order around the ＋ button. The nav
 * owns their icons; this owns the hrefs, because "is this a tab route?" is
 * what decides whether the header shows the wordmark or a back button.
 */
export const TABS = [
  { href: "/", label: "Home" },
  { href: "/bar", label: "My Bar" },
  { href: "/friends", label: "Friends" },
  { href: "/chat", label: "Chat" },
] as const;

export type TabHref = (typeof TABS)[number]["href"];

/**
 * Routes that render with neither header nor nav.
 *
 * - `/sign-in`, `/welcome`, `/s/[code]` — STORYBOARD §1.1: the first two are
 *   the first-run flow, and a share page is a landing page for someone who
 *   may not have an account, so five tabs they cannot use are noise.
 * - `/age` — a blocking screen (§3.14); every tab behind it redirects back.
 * - `/app-update` — the outage screen (§3.15), full screen over everything.
 */
const CHROMELESS_ROUTES = ["/sign-in", "/welcome", "/s", "/age", "/app-update"] as const;

/** `/foo/` and `/foo` are the same route; the root stays `/`. */
function normalize(pathname: string): string {
  if (!pathname) return "/";
  const bare = pathname.split(/[?#]/)[0] ?? "/";
  return bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare || "/";
}

function matches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** A bottom-nav destination itself — not anything nested under one. */
export function isTabRoute(pathname: string): boolean {
  const path = normalize(pathname);
  return TABS.some((tab) => tab.href === path);
}

/** No header and no bottom nav on this route. */
export function isChromeless(pathname: string): boolean {
  const path = normalize(pathname);
  return CHROMELESS_ROUTES.some((route) => matches(path, route));
}

/**
 * What a back button says when it returns to `pathname` — "labelled with
 * where you came from" (STORYBOARD §1.1). Short enough for a header slot;
 * a route with no good name gets `null` and the caller says "Back".
 */
export function routeLabel(pathname: string): string | null {
  const path = normalize(pathname);
  const tab = TABS.find((t) => t.href === path);
  if (tab) return tab.label;

  const [first, second, third] = path.split("/").filter(Boolean);
  switch (first) {
    case "history":
      return "Journal";
    case "search":
      return "Search";
    case "bottles":
      if (second === "new") return "Add a bottle";
      return third === "compare" ? "Compare" : "Bottle";
    case "u":
      return second ? `@${decodeSegment(second)}` : "Profile";
    case "add":
      return "Friends";
    case "notes":
      return "Tasting note";
    case "passport":
      return "Passport";
    case "learn":
      if (!second) return "Whiskey School";
      return second === "flavors" ? "Flavor wheel" : "Lesson";
    case "scan":
      return "Scan";
    case "pour":
      return "Log a pour";
    case "import":
      return "Import";
    case "sharing":
      return "Sharing";
    case "terms":
      return "Terms";
    case "privacy":
      return "Privacy";
    case "support":
      return "Support";
    case "responsible":
      return "Drinking responsibly";
    default:
      return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface ParentRoute {
  href: string;
  label: string;
}

export interface ParentContext {
  signedIn: boolean;
  /** The viewer's own social handle, when they have claimed one. */
  profileHandle: string | null;
}

const HOME: ParentRoute = { href: "/", label: "Home" };

/**
 * Where back goes when there is no in-app history — a deep link, a shared
 * URL, a fresh tab. This is the route's logical parent in the IA, not a
 * guess at the last page: the header uses it for the server render (and so
 * for every first paint) and swaps in the real previous page once the
 * client knows it.
 */
export function parentRoute(pathname: string, ctx: ParentContext): ParentRoute {
  const path = normalize(pathname);
  const [first, second, third] = path.split("/").filter(Boolean);
  const ownProfile: ParentRoute | null = ctx.profileHandle
    ? { href: `/u/${encodeURIComponent(ctx.profileHandle)}`, label: "Profile" }
    : null;

  switch (first) {
    case "bottles":
      if (second && second !== "new" && third === "compare") {
        return { href: `/bottles/${second}`, label: "Bottle" };
      }
      if (second === "new") return { href: "/search", label: "Search" };
      // Signed out, the catalog is the only shelf there is.
      return ctx.signedIn ? { href: "/bar", label: "My Bar" } : { href: "/search", label: "Search" };
    case "learn":
      return second ? { href: "/learn", label: "Whiskey School" } : HOME;
    case "passport":
      return ownProfile ?? HOME;
    case "sharing":
      return ownProfile ?? { href: "/friends", label: "Friends" };
    case "u":
    case "add":
    case "notes":
      return { href: "/friends", label: "Friends" };
    case "scan":
    case "import":
      return ctx.signedIn ? { href: "/bar", label: "My Bar" } : HOME;
    default:
      // Journal, search, pour, the policy pages, anything unknown.
      return HOME;
  }
}
