# Subscription-backed catalog automation

Whaikey has three separate automation lanes. Keeping them separate prevents model output from becoming catalog authority and keeps paid API usage opt-in.

## 1. Deterministic source scan

Workflow: `.github/workflows/source-backed-catalog-scan.yml`

- Runs weekly on a GitHub-hosted runner and can be dispatched manually.
- Uses `config/catalog-resource-manifest.json` and `pnpm ingest resources`.
- Uses no LLM or model API.
- Scheduled runs apply changes; manual runs default to dry-run.
- All fetched URLs still pass the source registry, HTTPS, DNS/SSRF, redirect, size, authority, and media-rights gates.

Expand the curated manifest deliberately. Exact bottle-to-page assignments are preferred to fuzzy matching.

## 2. Bounded subscription verification

Workflow: `.github/workflows/subscription-catalog-verification.yml`

This is a manual, finite controller over the durable verification queue. `limit` is the total bottle budget, workers and batch size are capped, every result is reconciled to an exact leased bottle ID, and provenance is persisted before status changes.

The job intentionally runs on `[self-hosted, linux, whaikey-ai]` and has **no API-key fallback**. Configure a private runner that:

1. Is dedicated to this repository (never expose it to fork/pull-request code).
2. Has Node 22, GitHub's runner service, and the `claude` CLI installed.
3. Runs under a non-root service account with a persisted Claude Code subscription login (`claude auth login`).
4. Has the custom `whaikey-ai` runner label.
5. Can reach the production database only through the `catalog-production` GitHub environment and `DATABASE_URL` secret.
6. Uses environment reviewers if production writes need an approval gate.

Dry-run mode does not call Claude and does not write queue/catalog data. Apply mode performs an authenticated smoke probe before claiming any lease.

## 3. Issue-driven whiskey feedback

Issue form: `.github/ISSUE_TEMPLATE/whiskey-catalog-feedback.yml`

Workflow: `.github/workflows/whiskey-feedback-review.yml`

1. A user submits one bottle ID/URL, a quick-select concern, and optional comments.
2. The issue receives `whiskey-feedback` and `needs-ai-review`.
3. A maintainer applies `ai-review-approved` (or manually dispatches the workflow).
4. The private subscription runner loads reviewed code from the default branch, stores the issue payload as JSON without shell interpolation, and runs one bounded structured-output search.
5. The issue body is treated as untrusted data. Claude is allowed only `WebSearch` and `WebFetch`; it cannot use shell or repository tools.
6. The model may suggest at most six exact URLs. It cannot write bottle facts or grant official authority directly. URLs are normalized and stored as link-only producer/review/retailer evidence. A maintainer must separately add a producer URL to the curated source manifest before deterministic parsing can treat it as canonical authority.
7. The workflow comments with attributed links and the validated ingestion report, then changes the issue label to `ai-reviewed`. Failures are labeled `ai-review-failed` and can be retried deliberately.

Create these repository labels before enabling the flow:

- `whiskey-feedback`
- `needs-ai-review`
- `ai-review-approved`
- `ai-reviewed`
- `ai-review-failed`

## API-cost policy

Scheduled `catalog-sync.yml` no longer runs API-key enrichment. API enrichment remains a manual opt-in for emergencies. The normal AI lanes use the authenticated Claude Code subscription on the private runner.

A Codex subscription lane should only be added after a supported Codex CLI is installed and authenticated on the private runner and its structured-output/tool restriction contract is covered by adapter tests. Do not emulate a subscription with an API key or silently fall back to metered APIs.
