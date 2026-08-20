# Source-backed catalog: Phase 1 + Phase 2 implementation plan

## Goal

Replace broad per-bottle web research with a deterministic, manifest-driven source pipeline. Official product pages establish canonical provenance and may fill missing catalog facts. Editorial pages remain linked, attributed resources and never silently overwrite canonical bottle data. LLM enrichment remains optional and only receives already-extracted, cited facts.

## Scope

### Phase 1 — canonical product resources

- Add source, resource, claim, and media tables with retrieval timestamps and explicit media-use policy.
- Add a safe HTML/JSON-LD/OpenGraph parser for manually curated official product and producer URLs.
- Persist exact source URLs and extracted facts idempotently.
- Promote `imported` bottles only from an official product page or existing qualifying retailer verification; TTB stays discovery-only.
- Fill only missing curated bottle fields from official product claims.
- Add manifest-based CLI ingestion with dry-run as the default and explicit `--apply` for writes.

### Phase 2 — editorial resources

- Register respected editorial sources independently from official sources.
- Extract metadata, structured review scores, and media references without copying review prose.
- Store editorial facts as cited claims; never use them to promote catalog status or overwrite canonical product data.
- Show official, producer, and editorial links on bottle detail pages with source labels and retrieval dates.
- Show remote imagery only when the manifest explicitly permits display; otherwise keep it as a link/review-required asset.

## Files and contracts

1. `src/db/schema.ts`: source, resource, claim, and media tables.
2. `src/lib/ingest/source-backed.ts`: manifest validation, URL safety, JSON-LD/OpenGraph extraction, normalized output, idempotent persistence.
3. `scripts/ingest.ts`: `pnpm ingest resources --manifest <path> [--apply]`; no writes unless `--apply` is supplied.
4. `src/lib/search.ts`: include resources, accepted claims, and displayable media in bottle details.
5. `src/components/source-backed-resources.tsx`: mobile-first imagery and grouped external resources.
6. `config/catalog-sources.json` plus an example resource manifest.
7. Focused parser, persistence, API, and component tests.

## Guardrails

- No TTB URL can verify a product.
- No editorial source can promote catalog status or overwrite canonical fields.
- No review body is stored or republished; only page metadata, score claims, and outbound links.
- No image is cached or rendered unless source policy explicitly permits remote display.
- No private/local-network URL may be fetched.
- Existing curated values always win.
- Writes require explicit `--apply`; dry-run is the CLI default.

## Verification

1. Observe focused tests fail before implementation.
2. Generate the migration through Drizzle Kit.
3. Run focused parser, persistence, API, and component tests.
4. Run constrained typecheck/lint and `git diff --check`.
5. Add deterministic demo resources and inspect bottle-page visual output if the local stack is available.
6. Independent diff review before publishing.
