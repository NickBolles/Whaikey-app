import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { upcLookupCache, upcProviderUsage } from "@/db/schema";
import { setupTestDb } from "@/test/helpers";
import {
  backoffMs,
  lookupExternalUpc,
  providerStatus,
  reserveRequest,
  utcDay,
} from "./upc-providers";

const UPC = "080244002145";
const NOW = new Date("2026-10-25T12:00:30Z");
const at = (iso: string) => () => new Date(iso);

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const fake = (fn: FetchFn) => vi.fn(fn) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("provider order and parsing", () => {
  it("returns the UPCitemdb title when available", async () => {
    const f = fake(async () => Response.json({ items: [{ title: "Buffalo Trace Bourbon 750ml" }] }));
    const r = await lookupExternalUpc(db, UPC, { fetch: f, env: {}, now: () => NOW });
    expect(r.product).toEqual({ name: "Buffalo Trace Bourbon 750ml", provider: "upcitemdb", cached: false });
    expect(r.trace.map((t) => t.outcome)).toEqual(["disabled", "hit"]);
  });

  it("falls back to Open Food Facts when UPCitemdb misses", async () => {
    const f = fake(async (url) =>
      url.includes("upcitemdb")
        ? Response.json({ items: [] })
        : Response.json({ product: { product_name: "Lagavulin 16", brands: "Lagavulin" } }),
    );
    const r = await lookupExternalUpc(db, "5000267107011", { fetch: f, env: {}, now: () => NOW });
    expect(r.product).toMatchObject({ name: "Lagavulin Lagavulin 16", provider: "openfoodfacts" });
  });

  it("tries the configured whiskey API first, with its key", async () => {
    const env = { WHAIKEY_WHISKY_UPC_URL: "https://whisky.example/spirits?barcode={upc}", WHAIKEY_WHISKY_UPC_KEY: "secret" };
    const f = fake(async (url, init) => {
      expect(url).toBe(`https://whisky.example/spirits?barcode=${UPC}`);
      expect((init?.headers as Record<string, string>)["API-Key"]).toBe("secret");
      return Response.json({ spirits: [{ name: "Ardbeg 10 Year" }] });
    });
    const r = await lookupExternalUpc(db, UPC, { fetch: f, env, now: () => NOW });
    expect(r.product?.provider).toBe("whiskyapi");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("uses the paid UPCitemdb endpoint and key when UPCITEMDB_KEY is set", async () => {
    const f = fake(async (url, init) => {
      expect(url).toContain("/prod/v1/lookup");
      expect((init?.headers as Record<string, string>).user_key).toBe("k");
      return Response.json({ items: [{ title: "X" }] });
    });
    await lookupExternalUpc(db, UPC, { fetch: f, env: { UPCITEMDB_KEY: "k" }, now: () => NOW });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("can switch providers off", async () => {
    const f = fake(async () => Response.json({}));
    const r = await lookupExternalUpc(db, UPC, {
      fetch: f,
      env: { WHAIKEY_UPCITEMDB: "off", WHAIKEY_OPENFOODFACTS: "off" },
      now: () => NOW,
    });
    expect(f).not.toHaveBeenCalled();
    expect(r.product).toBeNull();
  });

  it("returns null (never throws) when every provider errors", async () => {
    const f = fake(async () => {
      throw new Error("network down");
    });
    const r = await lookupExternalUpc(db, UPC, { fetch: f, env: {}, now: () => NOW });
    expect(r.product).toBeNull();
    expect(r.trace.filter((t) => t.outcome === "error")).toHaveLength(2);
  });

  it("treats 401/403 as a provider fault, never a cached miss", async () => {
    for (const status of [401, 403]) {
      const f = fake(async () => new Response("denied", { status }));
      const r = await lookupExternalUpc(db, UPC, { fetch: f, env: { WHAIKEY_OPENFOODFACTS: "off" }, now: () => NOW });
      expect(r.product).toBeNull();
      // The first is a fault; the provider is then backed off.
      expect(r.trace.find((t) => t.provider === "upcitemdb")?.outcome).toMatch(/^(error|backoff)$/);
    }
    expect(await db.select().from(upcLookupCache)).toHaveLength(0);
  });

  it("treats an HTML 200 (parked domain) as a provider fault, not a cached miss", async () => {
    const f = fake(async () => new Response("<html>parked</html>", { status: 200 }));
    await lookupExternalUpc(db, UPC, { fetch: f, env: { WHAIKEY_OPENFOODFACTS: "off" }, now: () => NOW });
    expect(await db.select().from(upcLookupCache)).toHaveLength(0);
  });
});

describe("permanent cache", () => {
  it("a hit is cached forever and never re-requested", async () => {
    const f = fake(async () => Response.json({ items: [{ title: "Eagle Rare 10" }] }));
    await lookupExternalUpc(db, UPC, { fetch: f, env: {}, now: () => NOW });
    const later = await lookupExternalUpc(db, UPC, { fetch: f, env: {}, now: at("2028-01-01T00:00:00Z") });
    expect(f).toHaveBeenCalledTimes(1);
    expect(later.product).toEqual({ name: "Eagle Rare 10", provider: "upcitemdb", cached: true });
    const [row] = await db.select().from(upcLookupCache);
    expect(row.expiresAt).toBeNull();
  });

  it("a miss is cached for a while, then asked again", async () => {
    const f = fake(async () => Response.json({ items: [] }));
    const env = { WHAIKEY_OPENFOODFACTS: "off" };
    await lookupExternalUpc(db, UPC, { fetch: f, env, now: () => NOW });
    await lookupExternalUpc(db, UPC, { fetch: f, env, now: at("2026-11-01T00:00:00Z") });
    expect(f).toHaveBeenCalledTimes(1);
    await lookupExternalUpc(db, UPC, { fetch: f, env, now: at("2026-12-01T00:00:00Z") });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a 404 is a miss, not a failure", async () => {
    const f = fake(async () => new Response("{}", { status: 404 }));
    const r = await lookupExternalUpc(db, UPC, { fetch: f, env: { WHAIKEY_OPENFOODFACTS: "off" }, now: () => NOW });
    expect(r.trace.find((t) => t.provider === "upcitemdb")?.outcome).toBe("miss");
    const [usage] = await db.select().from(upcProviderUsage);
    expect(usage.backoffUntil).toBeNull();
  });
});

describe("daily budget", () => {
  it("stops calling UPCitemdb at the budget and degrades to the next provider", async () => {
    const env = { WHAIKEY_UPCITEMDB_DAILY_BUDGET: "2", WHAIKEY_UPCITEMDB_PER_MINUTE: "unlimited" };
    const calls: string[] = [];
    const f = fake(async (url) => {
      calls.push(url.includes("upcitemdb") ? "upc" : "off");
      return url.includes("upcitemdb") ? Response.json({ items: [] }) : Response.json({ product: {} });
    });
    for (const code of ["080244002145", "082184090466", "088004021344"]) {
      await lookupExternalUpc(db, code, { fetch: f, env, now: () => NOW });
    }
    expect(calls.filter((c) => c === "upc")).toHaveLength(2);
    expect(calls.filter((c) => c === "off")).toHaveLength(3);
    const third = await lookupExternalUpc(db, "080432400432", { fetch: f, env, now: () => NOW });
    expect(third.trace.find((t) => t.provider === "upcitemdb")?.outcome).toBe("budget");
  });

  it("resets on the next UTC day", async () => {
    const limits = { perDay: 1, perMinute: null };
    expect(await reserveRequest(db, "upcitemdb", NOW, limits)).toBe(true);
    expect(await reserveRequest(db, "upcitemdb", NOW, limits)).toBe(false);
    expect(await reserveRequest(db, "upcitemdb", new Date("2026-10-26T00:00:01Z"), limits)).toBe(true);
  });

  it("enforces the per-minute limit and reopens next minute", async () => {
    const limits = { perDay: 100, perMinute: 2 };
    expect(await reserveRequest(db, "upcitemdb", NOW, limits)).toBe(true);
    expect(await reserveRequest(db, "upcitemdb", NOW, limits)).toBe(true);
    expect(await reserveRequest(db, "upcitemdb", NOW, limits)).toBe(false);
    expect(await reserveRequest(db, "upcitemdb", new Date(NOW.getTime() + 60_000), limits)).toBe(true);
  });

  it("defaults the trial below its 100/day cap", async () => {
    const [s] = (await providerStatus(db, { env: {}, now: () => NOW })).filter((p) => p.provider === "upcitemdb");
    expect(s.perDay).toBe(95);
    const [paid] = (await providerStatus(db, { env: { UPCITEMDB_KEY: "k" }, now: () => NOW })).filter(
      (p) => p.provider === "upcitemdb",
    );
    expect(paid.perDay).toBeNull();
  });
});

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(50)).toBe(6 * 3_600_000);
  });

  it("a 429 on a capped provider backs off until the day rolls", async () => {
    const f = fake(async (url) =>
      url.includes("upcitemdb") ? new Response("slow down", { status: 429 }) : Response.json({ product: {} }),
    );
    const r = await lookupExternalUpc(db, UPC, { fetch: f, env: {}, now: () => NOW });
    expect(r.trace.find((t) => t.provider === "upcitemdb")?.outcome).toBe("throttled");
    const [usage] = await db
      .select()
      .from(upcProviderUsage)
      .where(and(eq(upcProviderUsage.provider, "upcitemdb"), eq(upcProviderUsage.day, utcDay(NOW))));
    expect(usage.backoffUntil?.toISOString()).toBe("2026-10-26T00:00:00.000Z");

    f.mockClear();
    const again = await lookupExternalUpc(db, "082184090466", { fetch: f, env: {}, now: () => NOW });
    expect(again.trace.find((t) => t.provider === "upcitemdb")?.outcome).toBe("backoff");
    expect(f.mock.calls.every(([url]) => !String(url).includes("upcitemdb"))).toBe(true);
  });

  it("honours Retry-After", async () => {
    const f = fake(async () => new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await lookupExternalUpc(db, UPC, { fetch: f, env: { WHAIKEY_OPENFOODFACTS: "off" }, now: () => NOW });
    const [usage] = await db.select().from(upcProviderUsage);
    expect(usage.backoffUntil?.getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("a 5xx backs off briefly, then a success clears the failure count", async () => {
    let fail = true;
    const f = fake(async () => (fail ? new Response("", { status: 503 }) : Response.json({ items: [{ title: "T" }] })));
    const env = { WHAIKEY_OPENFOODFACTS: "off" };
    await lookupExternalUpc(db, UPC, { fetch: f, env, now: () => NOW });
    const blocked = await lookupExternalUpc(db, UPC, { fetch: f, env, now: () => new Date(NOW.getTime() + 30_000) });
    expect(blocked.trace[1].outcome).toBe("backoff");
    fail = false;
    const ok = await lookupExternalUpc(db, UPC, { fetch: f, env, now: () => new Date(NOW.getTime() + 61_000) });
    expect(ok.product?.name).toBe("T");
    const [usage] = await db.select().from(upcProviderUsage);
    expect(usage.failures).toBe(0);
  });
});
