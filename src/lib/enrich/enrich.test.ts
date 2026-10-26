import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleEnrichmentEvents,
  bottleEnrichmentJobs,
  bottleFlavorProvenance,
  bottles,
  enrichmentCalls,
  enrichmentRuns,
} from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { runBatch } from "./batch";
import {
  callEstimateUsd,
  canSpend,
  DEFAULT_DAILY_BUDGET_USD,
  enrichedByDay,
  getSettings,
  lastUtcDays,
  recordCall,
  releaseCall,
  reserveCall,
  spendByDay,
  spendByRun,
  spendSeries,
  spendSince,
  updateSettings,
  utcMonthStart,
} from "./budget";
import { settleKicks } from "./kick";
import { quickPrompt, webPrompt } from "./prompts";
import {
  anthropicProvider,
  enrichEnabledByEnv,
  enrichLive,
  openAiProvider,
  selectedProviderName,
  setEnrichProviderForTests,
  type CompleteInput,
  type EnrichProvider,
} from "./providers";
import {
  ENRICH_LIMIT_PER_HOUR,
  ENRICH_MAX_ATTEMPTS,
  enqueueEnrichment,
  getEnrichmentView,
  queueStats,
  recentJobs,
  requeueBottle,
  retryFailedJobs,
  runNextStep,
  sweepEnrichment,
} from "./queue";
import { cleanDetails, cleanSources, parseQuickResult, parseWebResult, profileHeadline } from "./validate";

const PROFILE = { fruity: 3, floral: 1, grain: 4, sweet: 6, woody: 5, spicy: 3, peaty: 0, feinty: 1 };
const WEB_PROFILE = { fruity: 4, floral: 2, grain: 3, sweet: 7, woody: 6, spicy: 4, peaty: 0, feinty: 1 };
const usage = { inputTokens: 900, outputTokens: 300, cachedInputTokens: 0, webSearches: 0 };

/** A scripted provider: quick replies with a profile for every id in the prompt, web with sourced notes. */
function fakeProvider(over: Partial<{ quick: (i: CompleteInput) => string; web: (i: CompleteInput) => string; fail: boolean }> = {}) {
  const calls: CompleteInput[] = [];
  const provider: EnrichProvider = {
    name: "openai",
    quickModel: "gpt-6-luna",
    webModel: "gpt-6.1-sol",
    async complete(input) {
      calls.push(input);
      if (over.fail) throw new Error("boom");
      if (input.web) {
        const text = over.web?.(input) ??
          JSON.stringify({
            profile: WEB_PROFILE,
            notes: { nose: "Caramel, orange peel", palate: "Toffee and baking spice", finish: "Long, oaky" },
            leaves: ["caramel", "not-a-leaf"],
            details: { abv: 46.5, ageYears: 12, caskTypes: ["ex-bourbon"], mashBill: "75% corn", country: "united states" },
            sources: [{ url: "https://example-reviews.com/review", label: "Example Reviews" }, { url: "http://insecure.test/x" }],
          });
        return { text, usage: { ...usage, webSearches: 2 } };
      }
      const ids = [...input.prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      const text = over.quick?.(input) ?? JSON.stringify(ids.map((id) => ({ id, profile: PROFILE })));
      return { text, usage };
    },
  };
  return { provider, calls };
}

let db: DB;

beforeEach(async () => {
  db = await setupTestDb();
  process.env.ENRICH_ENABLED = "true";
});

afterEach(() => {
  setEnrichProviderForTests(undefined);
  delete process.env.ENRICH_ENABLED;
  delete process.env.ENRICH_PROVIDER;
  vi.unstubAllEnvs();
});

async function newBottle(over: Partial<typeof bottles.$inferInsert> = {}) {
  const user = await createTestUser(db);
  const bottle = await createTestBottle(db, {
    flavorProfile: null,
    abv: null,
    description: "Rich vanilla and caramel with toasted oak and a hint of cinnamon.",
    submittedBy: user.id,
    ...over,
  });
  return { user, bottle };
}

const events = async (jobId: string) =>
  db.select().from(bottleEnrichmentEvents).where(eq(bottleEnrichmentEvents.jobId, jobId)).orderBy(bottleEnrichmentEvents.seq);
const job = async (jobId: string) => (await db.select().from(bottleEnrichmentJobs).where(eq(bottleEnrichmentJobs.id, jobId)))[0];

describe("provider selection", () => {
  it("is inert by default: no ENRICH_ENABLED, no key → nothing live", () => {
    delete process.env.ENRICH_ENABLED;
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(enrichEnabledByEnv()).toBe(false);
    expect(selectedProviderName()).toBeNull();
    expect(enrichLive()).toBe(false);
  });

  it("auto prefers OpenAI, falls back to Anthropic, and honours ENRICH_PROVIDER", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "ak-test");
    expect(selectedProviderName()).toBe("openai");
    vi.stubEnv("ENRICH_PROVIDER", "anthropic");
    expect(selectedProviderName()).toBe("anthropic");
    vi.stubEnv("ENRICH_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(selectedProviderName()).toBeNull();
    vi.stubEnv("ENRICH_PROVIDER", "auto");
    expect(selectedProviderName()).toBe("anthropic");
    expect(enrichLive()).toBe(true);
  });

  it("an existing chat key alone spends nothing until ENRICH_ENABLED=true", () => {
    delete process.env.ENRICH_ENABLED;
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "ak-test");
    expect(enrichLive()).toBe(false);
  });
});

describe("openAiProvider", () => {
  it("calls the Responses API with web search and reads text and usage", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.store).toBe(false);
      return new Response(
        JSON.stringify({
          output: [
            { type: "web_search_call" },
            { type: "web_search_call" },
            { type: "message", content: [{ type: "output_text", text: "{\"ok\":1}" }] },
          ],
          usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } },
        }),
        { status: 200 },
      );
    });
    const p = openAiProvider("sk-test", fetchImpl as unknown as typeof fetch);
    const res = await p.complete({ prompt: "x", model: p.webModel, web: true, timeoutMs: 5_000, maxOutputTokens: 100 });
    expect(res.text).toBe("{\"ok\":1}");
    expect(res.usage).toEqual({ inputTokens: 600, outputTokens: 200, cachedInputTokens: 400, webSearches: 2 });
  });

  it("turns an HTTP error into a ProviderCallError that still carries usage", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 }));
    const p = openAiProvider("sk-test", fetchImpl as unknown as typeof fetch);
    await expect(p.complete({ prompt: "x", model: p.quickModel, web: false, timeoutMs: 5_000, maxOutputTokens: 100 })).rejects.toThrow(/openai 429: quota/);
  });
});

describe("anthropicProvider", () => {
  it("resumes a paused server-tool turn and sums usage", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: "pause_turn",
        content: [{ type: "text", text: "part one" }],
        usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 2 } },
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "part two" }],
        usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 5 },
      });
    const p = anthropicProvider({ messages: { create } } as never);
    const res = await p.complete({ prompt: "x", model: p.webModel, web: true, timeoutMs: 10_000, maxOutputTokens: 100 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(res.text).toContain("part two");
    expect(res.usage).toEqual({ inputTokens: 150, outputTokens: 30, cachedInputTokens: 5, webSearches: 2 });
  });

  it("goes through the shared client seam, and drops hosted search where OpenRouter can't run it", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const { setAnthropicForTests } = await import("@/lib/ai/client");
    setAnthropicForTests({ messages: { create } } as never);
    try {
      vi.stubEnv("ANTHROPIC_API_KEY", "ak-test");
      await anthropicProvider().complete({ prompt: "x", model: "m", web: true, timeoutMs: 10_000, maxOutputTokens: 10 });
      expect(create.mock.calls[0][0]).toHaveProperty("tools");
      vi.stubEnv("OPENROUTER_API_KEY", "or-test");
      await anthropicProvider().complete({ prompt: "x", model: "m", web: true, timeoutMs: 10_000, maxOutputTokens: 10 });
      expect(create.mock.calls[1][0]).not.toHaveProperty("tools");
    } finally {
      setAnthropicForTests(null);
    }
  });

  it("wraps SDK failures", async () => {
    const p = anthropicProvider({ messages: { create: vi.fn().mockRejectedValue(new Error("overloaded")) } } as never);
    await expect(p.complete({ prompt: "x", model: p.quickModel, web: false, timeoutMs: 10_000, maxOutputTokens: 100 })).rejects.toThrow(/anthropic: overloaded/);
  });
});

describe("validation", () => {
  it("accepts only our id's valid profile", () => {
    expect(parseQuickResult(JSON.stringify([{ id: "other", profile: PROFILE }]), "b1")).toBeNull();
    expect(parseQuickResult(JSON.stringify([{ id: "b1", profile: PROFILE }]), "b1")).toEqual(PROFILE);
    expect(parseQuickResult("not json", "b1")).toBeNull();
  });

  it("keeps notes and details only with a public https source", () => {
    const unsourced = parseWebResult(JSON.stringify({ profile: PROFILE, notes: { nose: "Vanilla" }, details: { abv: 50 }, sources: [] }));
    expect(unsourced).toEqual({ profile: PROFILE, notes: null, details: {}, sources: [] });
    expect(cleanSources(["https://10.0.0.1/x", "https://localhost/x", "https://a.com/1", "https://a.com/2", "ftp://b.com"])).toEqual([
      { url: "https://a.com/1", label: "a.com" },
    ]);
    expect(cleanDetails({ abv: 120, ageYears: 2.5, country: "Atlantis", mashBill: "<b>60% rye</b>" })).toEqual({ mashBill: "60% rye" });
    expect(parseWebResult("{}")).toBeNull();
  });

  it("headlines the strongest wedges", () => {
    expect(profileHeadline(PROFILE)).toBe("Sweet, woody and grain lead");
    expect(profileHeadline({ ...PROFILE, sweet: 0, woody: 0, grain: 0, spicy: 0, fruity: 0, floral: 0, feinty: 0 })).toBe("");
  });

  it("never sends user notes", () => {
    const b = { id: "b1", name: "X", category: "bourbon", distillery: null, country: null, region: null, abv: null, ageYears: null, description: null };
    expect(quickPrompt(b)).not.toContain("userNotes\":[");
    expect(webPrompt(b)).toContain("STRICT JSON");
  });
});

describe("live jobs", () => {
  it("does nothing until enrichment is switched on", async () => {
    delete process.env.ENRICH_ENABLED;
    setEnrichProviderForTests(fakeProvider().provider);
    const { user, bottle } = await newBottle();
    expect(await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" })).toBeNull();
    expect(await db.select().from(bottleEnrichmentJobs)).toHaveLength(0);
  });

  it("runs keyword → quick → web, logs each step, fills only empty fields and records spend", async () => {
    const { provider, calls } = fakeProvider();
    setEnrichProviderForTests(provider);
    const { user, bottle } = await newBottle({ country: "Scotland" });
    const jobId = (await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" }))!;
    expect(jobId).toBeTruthy();
    // Only one job per bottle.
    expect(await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" })).toBeNull();

    expect(await runNextStep(db, jobId)).toEqual({ ran: "quick", next: "web" });
    expect(await runNextStep(db, jobId)).toEqual({ ran: "web", next: null });
    expect(calls.map((c) => c.web)).toEqual([false, true]);
    expect(calls.every((c) => !c.prompt.includes("userNotes\":["))).toBe(true);

    const j = await job(jobId);
    expect(j.state).toBe("done");
    expect(j.stepsDone).toEqual(["keyword", "quick", "web"]);
    expect(j.result?.notes?.nose).toBe("Caramel, orange peel");
    expect(j.result?.notes?.leaves).toEqual(["caramel"]);
    expect(j.result?.sources).toEqual([{ url: "https://example-reviews.com/review", label: "Example Reviews" }]);

    const [b] = await db.select().from(bottles).where(eq(bottles.id, bottle.id));
    expect(b.flavorProfile).toEqual(WEB_PROFILE);
    expect(b.abv).toBe(46.5);
    expect(b.ageYears).toBe(12);
    expect(b.country).toBe("Scotland"); // already set — never replaced
    const [prov] = await db.select().from(bottleFlavorProvenance).where(eq(bottleFlavorProvenance.bottleId, bottle.id));
    expect(prov.tier).toBe("model_web");

    const kinds = (await events(jobId)).map((e) => e.kind);
    expect(kinds[0]).toBe("queued");
    expect(kinds).toContain("claimed");
    expect(kinds.filter((k) => k === "found").length).toBeGreaterThanOrEqual(3);
    expect(kinds.at(-1)).toBe("done");

    const callsRows = await db.select().from(enrichmentCalls);
    expect(callsRows.map((c) => c.step).sort()).toEqual(["quick", "web"]);
    expect(await spendSince(db)).toBeGreaterThan(0);
    expect((await spendByDay(db))[0].calls).toBe(2);
    expect(await runNextStep(db, jobId)).toEqual({ ran: null, reason: "not-due" });
  });

  it("never overwrites an existing (legacy or higher-tier) profile or user-entered details", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const { user, bottle } = await newBottle({ flavorProfile: { sweet: 9, woody: 2 }, abv: 50.5 });
    const jobId = (await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" }))!;
    await runNextStep(db, jobId);
    await runNextStep(db, jobId);
    const [b] = await db.select().from(bottles).where(eq(bottles.id, bottle.id));
    expect(b.flavorProfile).toEqual({ sweet: 9, woody: 2 });
    expect(b.abv).toBe(50.5);
    const msgs = (await events(jobId)).map((e) => e.message);
    expect(msgs).toContain("Kept the profile we already had");
  });

  it("an unsourced web answer is stored at the quick tier and shows no notes", async () => {
    const { provider } = fakeProvider({ web: () => JSON.stringify({ profile: WEB_PROFILE, notes: { nose: "x" }, sources: [] }) });
    setEnrichProviderForTests(provider);
    const { user, bottle } = await newBottle({ description: null });
    const jobId = (await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "scan" }))!;
    await runNextStep(db, jobId);
    await runNextStep(db, jobId);
    const [prov] = await db.select().from(bottleFlavorProvenance).where(eq(bottleFlavorProvenance.bottleId, bottle.id));
    expect(prov.tier).toBe("model");
    expect((await job(jobId)).result?.notes).toBeUndefined();
    expect((await events(jobId)).map((e) => e.message)).toContain("No published notes found for this bottling");
  });

  it("parks on pause and on the daily cap, with one waiting line", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const { user, bottle } = await newBottle();
    await updateSettings(db, { paused: true });
    expect(await canSpend(db, "quick")).toEqual({ ok: false, reason: "paused" });
    const jobId = (await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" }))!;
    expect(await runNextStep(db, jobId)).toEqual({ ran: null, reason: "parked" });
    const j = await job(jobId);
    expect(j.state).toBe("queued");
    expect(j.waitingReason).toBe("paused");
    expect(j.stepsDone).toEqual(["keyword"]);
    const view = await getEnrichmentView(db, bottle.id, user.id);
    expect(view?.job?.waiting).toBe("paused");

    await updateSettings(db, { paused: false, dailyBudgetUsd: 0 });
    expect(await canSpend(db, "web")).toEqual({ ok: false, reason: "budget" });
    // Parked jobs wait out their backoff.
    expect(await runNextStep(db, jobId)).toEqual({ ran: null, reason: "not-due" });
    expect((await getSettings(db)).dailyBudgetUsd).toBe(0);
    await updateSettings(db, { dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD });
    expect(await canSpend(db, "web")).toEqual({ ok: true });
  });

  it("retries a failing model step, then gives up; the operator can requeue failures", async () => {
    setEnrichProviderForTests(fakeProvider({ fail: true }).provider);
    const { user, bottle } = await newBottle();
    const jobId = (await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" }))!;
    for (let i = 0; i < ENRICH_MAX_ATTEMPTS; i++) {
      await db.update(bottleEnrichmentJobs).set({ notBefore: new Date(0) }).where(eq(bottleEnrichmentJobs.id, jobId));
      await runNextStep(db, jobId);
    }
    expect((await job(jobId)).state).toBe("failed");
    expect((await db.select().from(enrichmentCalls)).every((c) => !c.ok)).toBe(true);
    expect((await queueStats(db)).failed).toBe(1);
    expect(await retryFailedJobs(db)).toBe(1);
    expect((await job(jobId)).state).toBe("queued");
  });

  it("limits live jobs per submitter", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const user = await createTestUser(db);
    let queued = 0;
    for (let i = 0; i < ENRICH_LIMIT_PER_HOUR + 2; i++) {
      const b = await createTestBottle(db, { submittedBy: user.id, flavorProfile: null });
      if (await enqueueEnrichment(db, { bottleId: b.id, submittedBy: user.id, reason: "new_bottle" })) queued++;
    }
    expect(queued).toBe(ENRICH_LIMIT_PER_HOUR);
  });

  it("hides someone else's pending submission from the feed", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const { user, bottle } = await newBottle({ status: "user_submitted" });
    await enqueueEnrichment(db, { bottleId: bottle.id, submittedBy: user.id, reason: "new_bottle" });
    const stranger = await createTestUser(db);
    expect(await getEnrichmentView(db, bottle.id, stranger.id)).toBeNull();
    expect(await getEnrichmentView(db, bottle.id, undefined)).toBeNull();
    const mine = await getEnrichmentView(db, bottle.id, user.id);
    expect(mine?.events.map((e) => e.kind)).toEqual(["queued"]);
    expect(await getEnrichmentView(db, bottle.id, user.id, 1)).toMatchObject({ events: [] });
  });

  it("re-enrich reopens a finished job for just the requested steps", async () => {
    const { provider, calls } = fakeProvider();
    setEnrichProviderForTests(provider);
    const { bottle } = await newBottle();
    const jobId = await requeueBottle(db, bottle.id, "refresh", ["web"]);
    expect(await runNextStep(db, jobId)).toEqual({ ran: "web", next: null });
    expect(calls).toHaveLength(1);
    const again = await requeueBottle(db, bottle.id, "admin");
    expect(again).toBe(jobId);
    expect((await job(jobId)).stepsDone).toEqual([]);
    expect((await recentJobs(db))[0].bottleName).toBe(bottle.name);
  });

  it("re-enrich never resets a job whose step is running right now", async () => {
    const { bottle } = await newBottle();
    const jobId = await requeueBottle(db, bottle.id, "admin");
    const lease = new Date(Date.now() + 60_000);
    await db.update(bottleEnrichmentJobs).set({ state: "running", leaseExpiresAt: lease, stepsDone: ["keyword"] }).where(eq(bottleEnrichmentJobs.id, jobId));
    expect(await requeueBottle(db, bottle.id, "admin")).toBe(jobId);
    expect(await job(jobId)).toMatchObject({ state: "running", stepsDone: ["keyword"] });
    // Once the lease lapses, it can be reopened.
    await db.update(bottleEnrichmentJobs).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(bottleEnrichmentJobs.id, jobId));
    await requeueBottle(db, bottle.id, "admin");
    expect(await job(jobId)).toMatchObject({ state: "queued", stepsDone: [] });
  });

  it("sweeps old progress lines and telemetry", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const { bottle } = await newBottle();
    const jobId = await requeueBottle(db, bottle.id, "refresh", ["web"]);
    await runNextStep(db, jobId);
    const old = new Date(Date.now() - 100 * 86_400_000);
    await db.update(bottleEnrichmentJobs).set({ finishedAt: old }).where(eq(bottleEnrichmentJobs.id, jobId));
    await db.update(enrichmentCalls).set({ createdAt: old });
    await sweepEnrichment(db);
    expect(await events(jobId)).toHaveLength(0);
    expect(await db.select().from(enrichmentCalls)).toHaveLength(0);
  });
});

describe("batch runs", () => {
  it("fills missing profiles in chunks and records the run and its spend", async () => {
    const { provider, calls } = fakeProvider();
    setEnrichProviderForTests(provider);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createTestBottle(db, { id: uid("b"), flavorProfile: null, description: null })).id);
    const result = await runBatch(db, { trigger: "admin", tiers: ["missing"], budgetMs: 55_000 });
    expect(result.stopReason).toBe("done");
    expect(result.counts.missingWritten).toBe(3);
    expect(calls).toHaveLength(1);
    const [run] = await db.select().from(enrichmentRuns);
    expect(run.state).toBe("done");
    expect((await spendByRun(db, [run.id])).get(run.id)?.calls).toBe(1);
    // Idempotent: nothing left to do.
    const again = await runBatch(db, { trigger: "admin", tiers: ["missing"], budgetMs: 55_000 });
    expect(again.counts.missingWritten ?? 0).toBe(0);
  });

  it("stops model tiers when disabled but still runs the free keyword tier", async () => {
    delete process.env.ENRICH_ENABLED;
    setEnrichProviderForTests(fakeProvider().provider);
    await createTestBottle(db, { flavorProfile: null });
    const result = await runBatch(db, { trigger: "cron", tiers: ["keyword", "missing"], budgetMs: 55_000 });
    expect(result.stopReason).toBe("disabled");
    expect(result.counts).toHaveProperty("keywordWritten");
  });

  it("stops for time before starting a step it can't finish", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    await createTestBottle(db, { flavorProfile: null });
    const result = await runBatch(db, { trigger: "cron", tiers: ["missing", "web"], budgetMs: 10_000 });
    expect(result.stopReason).toBe("deadline");
  });

  it("refreshes popular catalog bottles through the web step", async () => {
    const { provider, calls } = fakeProvider();
    setEnrichProviderForTests(provider);
    const user = await createTestUser(db);
    const b = await createTestBottle(db, { flavorProfile: null, status: "verified" });
    const { userBottles, RELATIONSHIPS: RELS } = await import("@/db/schema");
    await db.insert(userBottles).values({ id: uid("ub"), userId: user.id, bottleId: b.id, relationship: RELS[0] } as never);
    const result = await runBatch(db, { trigger: "admin", tiers: ["web"], budgetMs: 120_000 });
    expect(result.counts.webSteps).toBe(1);
    expect(calls.filter((c) => c.web)).toHaveLength(1);
    const [j] = await db.select().from(bottleEnrichmentJobs).where(eq(bottleEnrichmentJobs.bottleId, b.id));
    expect(j.reason).toBe("refresh");
    expect(j.state).toBe("done");
  });

  it("refreshes a top-searched legacy profile with a sourced answer, but never one with tasting notes", async () => {
    const { provider, calls } = fakeProvider();
    setEnrichProviderForTests(provider);
    const legacy = { fruity: 1, floral: 1, grain: 1, sweet: 1, woody: 1, spicy: 1, peaty: 9, feinty: 1 };
    const searched = await createTestBottle(db, { flavorProfile: legacy, status: "verified", name: "Searched Legacy" });
    const noted = await createTestBottle(db, { flavorProfile: legacy, status: "verified", name: "Noted Legacy" });
    const { bottlePopularityDaily, pours, tastingNotes } = await import("@/db/schema");
    const { utcDay } = await import("@/lib/popularity");
    await db.insert(bottlePopularityDaily).values([
      { bottleId: searched.id, day: utcDay(), searches: 20 },
      { bottleId: noted.id, day: utcDay(), searches: 40 },
    ]);
    const user = await createTestUser(db);
    const pourId = uid("pour");
    await db.insert(pours).values({ id: pourId, userId: user.id, bottleId: noted.id, rating: 4 });
    await db.insert(tastingNotes).values({ id: uid("note"), pourId, nose: "smoke" });

    const result = await runBatch(db, { trigger: "cron", tiers: ["web"], budgetMs: 120_000 });
    expect(result.counts.webSteps).toBe(1);
    expect(calls.filter((c) => c.web)).toHaveLength(1);
    const read = async (id: string) => (await db.select({ p: bottles.flavorProfile }).from(bottles).where(eq(bottles.id, id)))[0].p;
    expect(await read(searched.id)).toEqual(WEB_PROFILE);
    expect(await read(noted.id)).toEqual(legacy);
    const [p] = await db.select().from(bottleFlavorProvenance).where(eq(bottleFlavorProvenance.bottleId, searched.id));
    expect(p).toMatchObject({ tier: "model_web", replacedLegacyProfile: legacy });
  });
});

describe("budget reservations", () => {
  it("concurrent calls cannot both pass the cap on the same spend; reservations settle or release", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    await updateSettings(db, { dailyBudgetUsd: 0.25 });
    const input = { step: "web" as const, provider: "openai" as const, model: "gpt-6.1-sol" };
    const [a, b] = await Promise.all([reserveCall(db, input), reserveCall(db, input)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: "budget" });
    const held = [a, b].find((r) => r.ok) as { ok: true; reservationId: string };
    // An open reservation counts at its estimate.
    expect(await spendSince(db)).toBeCloseTo(0.2, 5);
    await recordCall(db, { reservationId: held.reservationId, step: "web", provider: "openai", model: "gpt-6.1-sol", usage, ok: true });
    const rows = await db.select().from(enrichmentCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: held.reservationId, pending: false, reservedUsd: 0, inputTokens: 900, ok: true });
    expect(await spendSince(db)).toBeLessThan(0.05);
    const again = await reserveCall(db, { ...input, step: "quick" });
    expect(again.ok).toBe(true);
    await releaseCall(db, (again as { reservationId: string }).reservationId);
    expect(await db.select().from(enrichmentCalls)).toHaveLength(1);
  });

  it("prices the reservation at the chosen model's limits, never below the step floor", () => {
    expect(callEstimateUsd("quick", "gpt-6-luna", { maxOutputTokens: 1_500 })).toBe(0.01);
    expect(callEstimateUsd("quick", "claude-opus-5", { maxOutputTokens: 1_500 })).toBeGreaterThan(0.03);
    expect(callEstimateUsd("web", "claude-sonnet-5", { maxOutputTokens: 4_000, maxSearches: 3 })).toBeGreaterThanOrEqual(0.2);
  });

  it("a failed call with no usage keeps its estimate counted", async () => {
    setEnrichProviderForTests(fakeProvider().provider);
    const r = await reserveCall(db, { step: "web", provider: "openai", model: "gpt-6.1-sol" });
    expect(r.ok).toBe(true);
    await recordCall(db, { reservationId: (r as { reservationId: string }).reservationId, step: "web", provider: "openai", model: "gpt-6.1-sol", usage: null, ok: false, error: "timeout" });
    const [row] = await db.select().from(enrichmentCalls);
    expect(row).toMatchObject({ pending: false, ok: false, reservedUsd: 0.2 });
    expect(await spendSince(db)).toBeCloseTo(0.2, 5);
  });
});

describe("admin series", () => {
  it("spend and profiles per day cover every day, oldest first", async () => {
    const now = new Date("2026-10-26T15:00:00Z");
    await db.insert(enrichmentCalls).values([
      { id: uid("c"), step: "web", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 8000, outputTokens: 600, webSearches: 2, ok: true, createdAt: new Date("2026-10-26T01:00:00Z") },
      { id: uid("c"), step: "quick", provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 300, ok: true, createdAt: new Date("2026-10-24T01:00:00Z") },
    ]);
    const a = await createTestBottle(db);
    const b = await createTestBottle(db);
    await db.insert(bottleFlavorProvenance).values([
      { bottleId: a.id, tier: "model_web", confidence: 0.75, method: "x", pass: "heavy", enrichedAt: new Date("2026-10-26T02:00:00Z") },
      { bottleId: b.id, tier: "keyword", confidence: 0.3, method: "x", pass: "free", enrichedAt: new Date("2026-10-25T02:00:00Z") },
    ]);
    const spend = await spendSeries(db, 30, now);
    expect(spend).toHaveLength(30);
    expect(spend[29].day).toBe("2026-10-26");
    expect(spend[29].usd).toBeGreaterThan(0);
    expect(spend[28].usd).toBe(0);
    expect(spend[27].calls).toBe(1);
    const enriched = await enrichedByDay(db, 30, now);
    expect(enriched.map((d) => d.day)).toEqual(lastUtcDays(30, now));
    expect(enriched[29]).toMatchObject({ total: 1, byTier: { model_web: 1, keyword: 0 } });
    expect(enriched[28]).toMatchObject({ total: 1, byTier: { keyword: 1 } });
    expect(utcMonthStart(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("kick", () => {
  it("runs work outside a request scope and reports failures instead of throwing", async () => {
    const { kick } = await import("./kick");
    let ran = false;
    kick(async () => {
      ran = true;
    });
    kick(async () => {
      throw new Error("nope");
    });
    await settleKicks();
    expect(ran).toBe(true);
  });
});
