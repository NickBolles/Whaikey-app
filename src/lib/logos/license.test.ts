import { describe, expect, it } from "vitest";
import { commonsLicense, logoAllowedOn, NOMINATIVE_USE } from "./license";
import { photoPriorityOrder } from "@/lib/photo-priority";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

describe("commonsLicense", () => {
  it("accepts public domain and CC0 without a credit", () => {
    expect(commonsLicense("Public domain")).toEqual({ license: "Public domain", attributionRequired: false });
    expect(commonsLicense("PD-textlogo")?.attributionRequired).toBe(false);
    expect(commonsLicense("CC0")?.attributionRequired).toBe(false);
  });
  it("accepts CC BY / BY-SA and asks for a credit", () => {
    expect(commonsLicense("CC BY-SA 4.0")).toEqual({ license: "CC BY-SA 4.0", attributionRequired: true });
    expect(commonsLicense("CC BY 3.0", "true")?.attributionRequired).toBe(true);
    expect(commonsLicense("CC BY 2.0", "false")?.attributionRequired).toBe(false);
  });
  it("refuses non-free, NC/ND and unknown licenses", () => {
    for (const l of ["Fair use", "Non-free logo", "CC BY-NC 4.0", "CC BY-ND 2.0", "All rights reserved", "GFDL", "", null]) {
      expect(commonsLicense(l as string | null)).toBeNull();
    }
  });
});

describe("logoAllowedOn", () => {
  const base = { status: "ok", logoSource: "wikidata" as const, license: "PD-textlogo", attributionRequired: false };
  it("shows public-domain marks everywhere", () => {
    expect(logoAllowedOn(base, "card")).toBe(true);
    expect(logoAllowedOn(base, "page")).toBe(true);
  });
  it("keeps credit-requiring marks to the page, where the credit is", () => {
    const by = { ...base, license: "CC BY-SA 4.0", attributionRequired: true };
    expect(logoAllowedOn(by, "card")).toBe(false);
    expect(logoAllowedOn(by, "page")).toBe(true);
  });
  it("shows site icons only under nominative use", () => {
    expect(logoAllowedOn({ ...base, logoSource: "website", license: NOMINATIVE_USE }, "card")).toBe(true);
    expect(logoAllowedOn({ ...base, logoSource: "website", license: "CC BY 4.0" }, "page")).toBe(false);
  });
  it("shows nothing without an ok status or a license", () => {
    expect(logoAllowedOn({ ...base, status: "none" }, "page")).toBe(false);
    expect(logoAllowedOn({ ...base, license: null }, "page")).toBe(false);
    expect(logoAllowedOn({ ...base, logoSource: null }, "page")).toBe(false);
  });
});

describe("photoPriorityOrder", () => {
  const dialect = new PgDialect();
  it("is a constant when no source has a priority", () => {
    expect(dialect.sqlToQuery(photoPriorityOrder(sql.raw("s.id"), [{ id: "a" }])).sql).toBe("0");
  });
  it("ranks prioritized sources first, the rest last", () => {
    const q = dialect.sqlToQuery(photoPriorityOrder(sql.raw("s.id"), [{ id: "a", photoPriority: 2 }, { id: "b", photoPriority: 1 }, { id: "c" }]));
    expect(q.sql).toBe("(case s.id when $1 then $2 when $3 then $4 else 1000000 end)");
    expect(q.params).toEqual(["a", 2, "b", 1]);
  });
});
