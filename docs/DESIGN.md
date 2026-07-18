# Whaikey Design System

The feel: **a well-lit whiskey lounge, not a dashboard.** Clean and sleek, warm and a little fancy — never sterile. Think aged oak, amber glass, brass hardware, cream paper labels.

## Type

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
8. Touch targets ≥ 44px. Focus states: `focus-visible:ring-2 ring-accent/60` (offset on dark).
9. Motion: 150–200ms color/opacity transitions only. Respect reduced motion.
10. The bottom nav is `sticky` (in flow), never `fixed` — full-page screenshots must stay honest.

## Screenshot workflow (how to iterate on UI)

```bash
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  pnpm playwright test --project=visual-mobile -g "<test name>" --update-snapshots
```

Then **open the PNG under `e2e/__screenshots__/visual-mobile/` and look at it.** Iterate until it matches this doc. CI fails on unreviewed drift; intentional changes ship new baselines in the same commit.

**Local renders are for review only — CI renders are the source of truth.** Font rasterization differs by environment, so a baseline rendered here (dev container / laptop) will not match a GitHub runner. The committed baselines are CI-canonical: they are generated inside the same `mcr.microsoft.com/playwright:<version>` container that CI uses. So the workflow is:

1. `pnpm e2e:update` locally and eyeball the PNGs to confirm the design change looks right.
2. `pnpm e2e:update:ci` (Docker required) to re-render those baselines in the CI container, then commit the result. Do **not** commit the raw local renders from step 1.

The visual-regression job runs in that same container (`retries=1`, `maxDiffPixelRatio=0.02`), and on failure uploads `playwright-report/` + `test-results/` as artifacts so the diff PNGs are reviewable from the PR.
