import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, setSessionUser, setupTestDb } from "@/test/helpers";
import { settleKicks } from "@/lib/enrich/kick";
import { setEnrichProviderForTests, type EnrichProvider } from "@/lib/enrich/providers";
import { requeueBottle } from "@/lib/enrich/queue";
import { POST } from "./route";
import { GET as feed } from "@/app/api/bottles/[id]/enrichment/route";
import { GET as cron } from "@/app/api/cron/enrich/route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

const PROFILE = { fruity: 3, floral: 1, grain: 4, sweet: 6, woody: 5, spicy: 3, peaty: 0, feinty: 1 };
const provider: EnrichProvider = {
  name: "anthropic",
  quickModel: "claude-haiku-4-5",
  webModel: "claude-sonnet-5",
  async complete(input) {
    const ids = [...input.prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    const text = input.web ? JSON.stringify({ profile: PROFILE, sources: [] }) : JSON.stringify(ids.map((id) => ({ id, profile: PROFILE })));
    return { text, usage: { inputTokens: 500, outputTokens: 100, cachedInputTokens: 0, webSearches: input.web ? 1 : 0 } };
  },
};

let db: DB;
let operator: schema.User;
let other: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  operator = await createTestUser(db, { name: "Op" });
  other = await createTestUser(db, { name: "Someone" });
  process.env.WHAIKEY_OPERATOR_IDS = operator.id;
  setSessionUser(operator);
});

afterEach(() => {
  delete process.env.WHAIKEY_OPERATOR_IDS;
  delete process.env.ENRICH_ENABLED;
  delete process.env.CRON_SECRET;
  setEnrichProviderForTests(undefined);
});

const post = (body: unknown) => POST(jsonRequest("/api/admin/enrichment", "POST", body));

describe("POST /api/admin/enrichment", () => {
  it("does not exist for anyone who is not an operator", async () => {
    setSessionUser(other);
    expect((await post({ action: "retry-failed" })).status).toBe(404);
    setSessionUser(null);
    expect((await post({ action: "retry-failed" })).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await post({ action: "settings", dailyBudgetUsd: -1 })).status).toBe(400);
    expect((await post({ action: "run", tiers: ["everything"] })).status).toBe(400);
  });

  it("pauses, resumes and sets the daily cap", async () => {
    const res = await post({ action: "settings", paused: true, dailyBudgetUsd: 5 });
    expect(await res.json()).toMatchObject({ settings: { paused: true, dailyBudgetUsd: 5 } });
    const resumed = await post({ action: "settings", paused: false });
    expect(await resumed.json()).toMatchObject({ settings: { paused: false, dailyBudgetUsd: 5 } });
  });

  it("refuses per-bottle re-enrich while inert, runs it once live", async () => {
    const bottle = await createTestBottle(db, { flavorProfile: null });
    expect((await post({ action: "reenrich", bottleId: bottle.id })).status).toBe(409);
    process.env.ENRICH_ENABLED = "true";
    setEnrichProviderForTests(provider);
    expect((await post({ action: "reenrich", bottleId: "nope" })).status).toBe(404);
    const res = await post({ action: "reenrich", bottleId: bottle.id });
    expect(res.status).toBe(200);
    await settleKicks();
    const [job] = await db.select().from(schema.bottleEnrichmentJobs).where(eq(schema.bottleEnrichmentJobs.bottleId, bottle.id));
    expect(job.reason).toBe("admin");
    expect(job.stepsDone).toContain("quick");
  });

  it("runs a batch chunk and requeues failures", async () => {
    const run = await post({ action: "run", tiers: ["keyword", "missing"] });
    expect(await run.json()).toMatchObject({ stopReason: "disabled" });
    expect(await (await post({ action: "retry-failed" })).json()).toEqual({ requeued: 0 });
  });
});

describe("GET /api/bottles/:id/enrichment", () => {
  it("serves the feed and moves a due job along", async () => {
    process.env.ENRICH_ENABLED = "true";
    setEnrichProviderForTests(provider);
    const bottle = await createTestBottle(db, { flavorProfile: null });
    await requeueBottle(db, bottle.id, "new_bottle");
    setSessionUser(other);
    const res = await feed(new Request(`http://localhost/api/bottles/${bottle.id}/enrichment?after=0`), { params: Promise.resolve({ id: bottle.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.state).toBe("queued");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await settleKicks();
    const again = await (await feed(new Request(`http://localhost/x?after=${body.job.lastSeq}`), { params: Promise.resolve({ id: bottle.id }) })).json();
    expect(again.events.length).toBeGreaterThan(0);
    expect(again.job.stepsDone).toContain("quick");
  });

  it("404s a bottle the viewer can't see", async () => {
    const bottle = await createTestBottle(db, { status: "user_submitted", submittedBy: operator.id });
    setSessionUser(other);
    const res = await feed(new Request("http://localhost/x?after=abc"), { params: Promise.resolve({ id: bottle.id }) });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/cron/enrich", () => {
  const req = (auth?: string) => new Request("http://localhost/api/cron/enrich", { headers: auth ? { authorization: auth } : {} });

  it("is a 404 without the cron secret and inert until enabled", async () => {
    expect((await cron(req())).status).toBe(404);
    process.env.CRON_SECRET = "s3cret";
    expect((await cron(req("Bearer wrong"))).status).toBe(404);
    const res = await cron(req("Bearer s3cret"));
    expect(await res.json()).toEqual({ ok: true, skipped: "enrichment not enabled" });
    expect(await db.select().from(schema.enrichmentRuns)).toHaveLength(0);
  });

  it("runs a chunk when live", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.ENRICH_ENABLED = "true";
    setEnrichProviderForTests(provider);
    await createTestBottle(db, { flavorProfile: null });
    const body = await (await cron(req("Bearer s3cret"))).json();
    expect(body.ok).toBe(true);
    expect(body.counts.missingWritten).toBe(1);
  });
});
