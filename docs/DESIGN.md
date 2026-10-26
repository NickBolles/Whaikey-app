# Caskfolk Design System

> **Amended 2026-10-26 (owner: rename to Caskfolk "for now", tone down button gradients).**
> Colour, type and wordmark follow the Caskfolk brand (rebrand v2 board); Ledger × Paper's
> layout, radii, density, pull-quotes, badge art and flavor wheel are unchanged.
> - **Name:** one constant, `src/lib/brand.ts` (`BRAND_NAME`, `BRAND_SLUG`, `BRAND_TAGLINE` "Pull up a chair.").
>   Internal identifiers keep `whaikey` until the final name decision (bundle id, scheme, domain, env vars, keys).
> - **Wordmark:** `src/components/brand-mark.tsx` — the cask-head/round-table mark (ring + staves in
>   `currentColor`, six copper seats) beside "Caskfolk" in Zilla Slab 600, upright.
> - **Type:** Display **Zilla Slab** (500/600/700, italic 500 for pull-quotes) via `--font-brand-display`;
>   UI **Work Sans** (variable) via `--font-brand-sans`. Where this file says Fraunces/Geist Sans below, read these.
> - **Colour (dark, default):** background `#0d1410` rickhouse, surface `#142019`, raised `#1b2a21` fir,
>   border `#26392d`, rule `#41604b`, text `#eee7d6` linen, muted `#93a092`, editorial `#c9a46a` brass,
>   quote `#f0e6cf`, accent `#d27b3e` copper (deep `#a9581f`), success `#a7c47a` moss.
>   Light ("linen") tokens exist behind `<html data-theme="light">`; dark stays the default.
> - **Buttons are flat.** `.btn-primary` = solid copper, 1px `--accent-deep` edge, dark-ground text
>   (`--accent-foreground`, 5.9:1); hover lifts to `--accent-hover`, press drops to `--accent-deep`.
>   No gradients or glows on any button. `.text-gradient-amber` is now a flat colour (name kept).
> - Contrast: every text token pair is ≥4.5:1 on its surfaces (muted 6.8/5.5, accent 5.9/4.75, editorial 8.0/6.4).
> - Hex values in the token table below are the pre-Caskfolk ones; `globals.css` is the source of truth.

The feel: **compact, dense, premium — a collector's ledger in a well-lit whiskey lounge.** Clean and sleek, warm and a little fancy — never sterile, and never roomy for its own sake. Think aged oak, amber glass, brass hardware, cream paper labels, and a tasting book where every line earns its place. More of the shelf, the journal and the bottle fits on one screen than in a typical consumer app; premium comes from type, colour and alignment, not from whitespace.

> **Amended 2026-10 (owner direction: "compact, dense, premium").** The previous rhythm (page `px-4`, sections `gap-6`/`mt-8`, cards `p-4`/`p-5`, `rounded-2xl` everywhere, emoji-led empty states) read as a roomy lounge and pushed primary actions below the fold on Home, Bar, Pour and Bottle. Rules 1, 4 and 6 are replaced and the **Density** section below is new. **Migration:** new and touched UI uses the dense rhythm immediately; the recipes in `globals.css` (`.card`, `.card-flat`, list rows) change in the Track B density PR (B0), which regenerates every affected baseline in one go. Until that PR lands, do not hand-roll dense variants per screen — use the existing recipes with the new spacing classes. Accessibility floors (rule 8's 44px hit areas, the 12px type floor, contrast) do not move.

> **Amended 2026-10-26 (owner direction: "Ledger × Paper").** The app keeps Ledger's density and takes Paper's layout and editorial voice, dark first: a double-rule masthead under an italic serif wordmark, serif small-caps section kickers in an editorial brass, Paper's hard-offset card shadow, and **pull-quotes** for tasting notes (feed, bottle page, journal). Tokens below are the dark Paper palette; the light variant lives on the design board (artifacts `whaikey-hybrid-20261026`) and is not shipped. Passport badge art and the flavor wheel are unchanged by owner request. See **Editorial** below.

## Type

> **Fonts are pinned, deliberately.** The `.woff2` files live in `src/app/fonts/`
> and load through `next/font/local` (src/app/layout.tsx); `next/font/google` is not
> used. Google serves whatever revision is current on the day of the build, so a font
> update silently re-wraps every line of type and breaks the baselines below with no
> code change behind it — which is exactly what happened on 27 July 2026, when a
> Fraunces revision put CI red on `main` for two weeks. Changing the type now means
> replacing a file: a reviewable diff that ships new baselines alongside it, like any
> other design change. Both faces are OFL-1.1 and the licences sit beside them.


- **Display: Fraunces** (`--font-display`, class `font-display`) — headings, big numerals, brand wordmark. Optical sizing on; use weight 600 for headings, 500 for numerals.
- **Body: Geist Sans** — everything else.
- Section labels: 11px (10.5px allowed in dense headers), uppercase, `tracking-[0.14em]`, `text-muted`.
- **Sizes (dense scale):** body 14px (`text-sm`), meta 12px (`text-xs`) — **12px is the floor** for anything a person reads; page titles Fraunces 20–22px; stat numerals Fraunces 18–24px. Numbers in tables and stats use `tabular-nums`.

## Color tokens (globals.css)

| Token | Use |
|---|---|
| `--background` #120e0a | page base — Paper's ground, in oak (soft amber radial vignette overlay) |
| `--surface` #1a140e / `--surface-raised` #231b12 | cards / elevated cards — use the `.card` class, not raw bg |
| `--border` #3a2e20 | hairlines (always 1px, warm) |
| `--rule` #5a4733 | Paper's ink rule: masthead double rule, pull-quote frames, `.rule-double` — never a fill |
| `--foreground` #f2e9d8 | primary text (warm cream) |
| `--muted` #a5937a | secondary text |
| `--editorial` #d9a25a | section kickers, `.kicker` — the editorial voice, softer than the accent |
| `--quote` #f2e3c4 | pull-quote text |
| `--accent` #e8a13c → `--accent-deep` #b96f1e | brass/amber; gradients via `.btn-primary`, `.text-gradient-amber` |
| `--danger`, `--success` | sparingly |
| `--taste-shared` #9db463 · `--taste-blind` #69a3bd · `--taste-signature` #bb8ad0 | the three calibration buckets on the Compare wheel — olive/slate/plum |

**Calibration colour is not a grade.** When the flavor map compares your notes to the label's, the three buckets are *shared* (you both call it), *blind spot* (the label does, you don't) and *yours alone* (you do, the label doesn't). Deliberately not red/green: a published tasting note is one opinion written by someone selling the bottle, so this is calibration against a reference point, never accuracy against an answer key. Each bucket also carries a distinct **shape** (filled dot / hollow ring / diamond) so the encoding survives colour-blindness and greyscale.

## Recipes (defined in globals.css — use these, don't improvise)

- `.card` — gradient surface (raised → surface), 1px warm border, `rounded-2xl`, faint inner top highlight. Default container for everything.
- `.card-flat` — surface only, for dense list rows.
- `.btn-primary` — amber→copper gradient, `rounded-xl`, dark text, subtle inner highlight + shadow; hover brightens.
- `.btn-secondary` — bordered surface button.
- `.chip` — small rounded-full bordered label; `.chip-active` amber-tinted.
- `.section-label` — the small-caps label style.
- `.stat-number` — `font-display` numeral styling for stats.

## Density (2026-10)

| Token | Dense value | Was |
|---|---|---|
| Page padding | `px-3` (12px) | `px-4` |
| Section spacing | `gap-3` / `mt-4` | `gap-6` / `mt-8` |
| Card padding | `p-3`; `p-2.5` for list cards | `p-4` / `p-5` |
| List row | 40px visual height, one line of identity + one muted meta line; `.tap-target` keeps the 44px hit area | ~56–64px |
| Card radius | `rounded-xl` cards, `rounded-lg` controls/inputs, `rounded-full` chips | `rounded-2xl` / `rounded-xl` |
| Stats | inline stat lines (`label value · label value`) before stat tiles; tiles only for the one or two numbers a screen is about | tiles |
| Empty state | one line + one action, inline where the content would be | emoji + serif line + muted line + action |

Principles: **content before chrome** (no decorative headers or hero padding above the primary action); **one screen, one job, above the fold** (STORYBOARD's rule, now achievable); **show more rows, not bigger rows** (lists default to compact density; the roomy variant is the exception and needs a reason); **progressive detail** (secondary detail behind a tap on the row, not stacked under it). Density never trades away legibility: if a dense layout needs type under 12px or hit areas under 44px, it is the wrong layout.

## Editorial (Ledger × Paper, 2026-10-26)

- **Masthead:** the app header sits on the page ground with a 3px double rule in `--rule` (`.rule-double border-b-[3px]`) and an italic Fraunces wordmark.
- **Kickers:** `.section-label` and `.kicker` are Fraunces, 11px, uppercase, `tracking-[0.16em]`, `--editorial`. A bottle's origin is the kicker above its name.
- **Pull-quotes** (`src/components/pull-quote.tsx`): a written tasting note is the one large italic line on its surface — 18px (hang, amber left rule + ghosted opening mark) on feed cards, 20px centred between double rules on the bottle page. Only for notes of at least `PULL_QUOTE_MIN_CHARS` (24); shorter text stays an ordinary line. Never more than one centred pull-quote per screen.
- **Feed card types:** the shape says what happened before you read it. Written note → *Tasting note* kicker + pull-quote with the bottle as byline. Rating without text → *Rated* kicker + a ledger line with a 20px serif score. New types (badge earned, tasting night, trail) follow the same kicker + body recipe and the SOCIAL.md ban list.
- **Search → Add this bottle:** whenever a typed query has results, a framed block above the list and a closing button under it offer "Add this bottle", prefilled from the query (48px, primary). This is a deliberate second accent on that one screen (owner direction).

## Rules

1. Radii: `rounded-xl` cards, `rounded-lg` buttons/inputs, `rounded-full` chips (Density table). Nothing square. *(Amended 2026-10; was `rounded-2xl` / `rounded-xl`.)*
2. One accent moment per screen — the primary action gets the gradient; everything else stays quiet.
3. Hairlines over shadows; shadows only on the primary button, sticky bars and `.card`'s hard 3px Paper offset (no blur — it reads as print, not elevation). *(Amended 2026-10-26.)*
4. Spacing rhythm: page padding `px-3`, sections `gap-3`/`mt-4`, intra-card `p-3` (Density table). *(Amended 2026-10; was `px-4`, `gap-6`/`mt-8`, `p-4`/`p-5`.)*
5. Icons: lucide, `size={18}` inline / `size={20}` nav, `strokeWidth={1.8}`; amber only when the element is active/accent.
6. Empty states: one line saying what will be here, and one clear action, in place of the content — an icon is optional, an emoji block is not used. *(Amended 2026-10; was emoji + serif line + muted line + action.)*
7. Text never touches an edge — SVG labels included (radar/wheel need internal padding).
8. Touch targets ≥ 44px. Where a control is deliberately compact — the Bar's filter bar, the wheel's lens — add `.tap-target` instead of raising its height: it grows the hit area to 44px and leaves the layout alone. **Check the ancestor can hold it:** an `overflow-x-auto` row clips the other axis too, so a scroller needs the vertical room or it silently trims the hit area back to the height of its chips — the class ends up applied and buying nothing. Focus states: `focus-visible:ring-2 ring-accent/60` (offset on dark).
9. Motion: 150–200ms color/opacity transitions only. Respect reduced motion.
10. The bottom nav is `sticky` (in flow), never `fixed` — full-page screenshots must stay honest.
11. **Passport crests go on a surface's trailing edge, never inline with its text.** A bottle's stamps (`BottleStamps`) always sit at the trailing end and are always struck at tier 0, the unstruck die — these surfaces describe the bottle, not the viewer, and a real metal frame would read as a tier the viewer holds. Never the leading slot: that belongs to a bottle shot, a distillery mark, or (on a My Bar row) the fill spine, and crests are no substitute for any of them. Never a text line either — on a 390px viewport a bottle card's identity line has ~46px of slack, so a long category ("Single Malt Scotch") plus specs already fills it, and three crests inline wrap the specs onto a second line and grow every long-category card. Give them a real gap; overlapped into a shingle they read as one smudge at 20px. The axis follows the surface's shape:
    - **Bottle card** (tall, narrow text column) — `column`, 20px, outboard of the price. Stacked, the run costs the text one crest's width instead of three.
    - **My Bar row** (short, wide, gutters already spoken for) — `row`, 19px, under the rating block. Stacked here, three crests spanned the whole row height and read as scattered specks, and shrinking them far enough to fit lost the engraving.
    - **Bottle detail hero** (full page width) — `row`, 34px, under the meta line. This is the bottle's own page, so the crests are the subject rather than an aside and can be large enough to actually read.
12. **Touch gestures say who owns the finger, and say it once.** A surface that both scrolls the page and runs its own drag — the flavor wheels — cannot settle that with `touch-action` alone: the browser latches it when the finger lands, so an element that scrolls on touch-down can never take that touch back. The pattern is a hold: the page keeps the touch until `WHEEL_HOLD_MS` of stillness passes, then `useWheelScrollLock` claims it (non-passive `touchmove` + `preventDefault`) and the drag runs in **any** direction — a radial sweep is a vertical drag for half the wheel, so an axis test refuses the very gesture it is meant to allow. Movement before the hold lands gives the touch back whole, cue and all.
13. **A full-screen sheet holds the page still behind it** — `useScrollLock` from `src/lib/scroll-lock.ts`. Without it the page scrolls under the sheet and the sheet's own scroll chains into the page at either end.

## Screenshot workflow (how to iterate on UI)

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  pnpm playwright test --project=visual-mobile -g "<test name>" --update-snapshots
```

Then **open the PNG under `e2e/__screenshots__/visual-mobile/` and look at it.** Iterate until it matches this doc. CI fails on unreviewed drift; intentional changes ship new baselines in the same commit.

**A baseline must not depend on when it was rendered.** The signed-in suite pins both the timezone (`test.use({ timezoneId: "UTC" })`) and the clock (`page.clock.setFixedTime`) in its `beforeEach`, because time-of-day copy — the Bar's "tonight" rail is the one we have — swaps between strings that wrap to different heights. Left unpinned, a shot passes or fails on the hour CI happened to run at: `bar-filter-panel` was generated at 22:30 UTC, went green on the PR that evening, and turned `main` red the next morning when the copy became two lines. Anything else you add that reads the clock, a locale, or a random seed belongs behind the same kind of pin.

**Local renders are for review only — CI renders are the source of truth.** Font rasterization differs by environment, so a baseline rendered here (dev container / laptop) will not match a GitHub runner. The committed baselines are CI-canonical: they are generated inside the same `mcr.microsoft.com/playwright:<version>` container that CI uses. So the workflow is:

1. `pnpm e2e:update` locally and eyeball the PNGs to confirm the design change looks right.
2. `pnpm e2e:update:ci` (Docker required) to re-render those baselines in the CI container, then commit the result. Do **not** commit the raw local renders from step 1.

The visual-regression job runs in that same container (`retries=1`, `maxDiffPixelRatio=0.02`), and on failure uploads `playwright-report/` + `test-results/` as artifacts so the diff PNGs are reviewable from the PR.
