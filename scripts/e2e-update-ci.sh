#!/usr/bin/env bash
#
# Regenerate the CI-canonical visual baselines inside the same Playwright
# container that GitHub Actions uses, so font rasterization matches CI exactly.
#
# Requires Docker. The baselines under e2e/__screenshots__/ produced by this
# script are the source of truth; a local `pnpm e2e:update` render is for
# review only (see README "Visual baselines").
#
# Usage: pnpm e2e:update:ci
set -euo pipefail

# Keep this tag in sync with @playwright/test in package.json.
IMAGE="mcr.microsoft.com/playwright:v1.61.1-noble"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is required and its daemon must be running." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Regenerating visual baselines in $IMAGE ..."
docker run --rm \
  --ipc=host \
  -v "$REPO_ROOT":/work \
  -w /work \
  -e CI=true \
  -e PLAYWRIGHT_CHROMIUM_PATH="" \
  "$IMAGE" \
  bash -c '
    set -euo pipefail
    corepack enable
    corepack prepare pnpm@10 --activate
    pnpm install --frozen-lockfile
    pnpm exec playwright install chromium
    pnpm e2e:update
  '

echo
echo "Done. Review the updated PNGs under e2e/__screenshots__/ before committing."
