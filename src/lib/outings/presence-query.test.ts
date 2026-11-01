import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { presenceBumpWhere } from "./index";

/**
 * postgres-js can't serialize a bare Date bound through a raw sql template
 * (see native-auth.ts) — the heartbeat cutoff must go through the column
 * encoder, i.e. reach the driver as an ISO string, never a Date.
 */
describe("presenceBumpWhere", () => {
  it("binds the cutoff through the timestamp column encoder", () => {
    const cutoff = new Date("2026-11-01T20:00:00.000Z");
    const where = presenceBumpWhere("p1", cutoff);
    expect(where).toBeDefined();
    const q = new PgDialect().sqlToQuery(where!);
    expect(q.params).toContain(cutoff.toISOString());
    expect(q.params.some((p) => p instanceof Date)).toBe(false);
    expect(q.sql).toMatch(/"last_seen_at" is null or .*"last_seen_at" < \$/);
  });
});
