# Whaikey Design System

The feel: **a well-lit whiskey lounge, not a dashboard.** Clean and sleek, warm and a little fancy — never sterile. Think aged oak, amber glass, brass hardware, cream paper labels.

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
- Section labels: 11px, uppercase, `tracking-[0.14em]`, `text-muted`.

## Color tokens (globals.css)

| Token | Use |
|---|---|
| `--background` #14100b | page base (has a soft amber radial vignette overlay) |
| `--surface` / `--surface-raised` | cards / elevated cards — use the `.card` class, not raw bg |
| `--border` #392e20 | hairlines (always 1px, warm) |
| `--foreground` #f4ecdd | primary text (warm cream) |
| `--muted` #a3927a | secondary text |
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

## Rules

1. Radii: `rounded-2xl` cards, `rounded-xl` buttons/inputs, `rounded-full` chips. Nothing square.
2. One accent moment per screen — the primary action gets the gradient; everything else stays quiet.
3. Hairlines over shadows; shadows only on the primary button and sticky bars.
4. Spacing rhythm: page padding `px-4`, sections `gap-6`/`mt-8`, intra-card `p-4`/`p-5`.
5. Icons: lucide, `size={18}` inline / `size={20}` nav, `strokeWidth={1.8}`; amber only when the element is active/accent.
6. Empty states: an emoji or icon, one serif line, one muted line, one clear action.
7. Text never touches an edge — SVG labels included (radar/wheel need internal padding).
8. Touch targets ≥ 44px. Where a control is deliberately compact — the Bar's filter bar, the wheel's lens — add `.tap-target` instead of raising its height: it grows the hit area to 44px and leaves the layout alone. **Check the ancestor can hold it:** an `overflow-x-auto` row clips the other axis too, so a scroller needs the vertical room or it silently trims the hit area back to the height of its chips — the class ends up applied and buying nothing. Focus states: `focus-visible:ring-2 ring-accent/60` (offset on dark).
9. Motion: 150–200ms color/opacity transitions only. Respect reduced motion.
10. The bottom nav is `sticky` (in flow), never `fixed` — full-page screenshots must stay honest.
11. **Passport crests on a list row go in a trailing rail, never inline with the text.** A bottle's stamps (`BottleStamps`) stack on the card's outer edge, outboard of the price. Not the leading slot — that belongs to a bottle shot or a distillery mark, and crests are no substitute for either. Not the identity line beside the category chip: on a 390px viewport that line has ~46px of slack, so a long category ("Single Malt Scotch") plus specs already fills it and three crests inline wrap the specs onto a second line, growing every long-category card. Stacked, the run costs the text one crest's width instead of three. Crests on a card are struck at tier 0, the unstruck die — a card knows nothing about who is looking at it, so a real metal frame there would read as a tier the viewer holds. Give them a real gap; overlapped into a shingle they read as one smudge at 20px.

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
