import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import {
  AgeAnswerAlreadyRecordedError,
  DEFAULT_MINIMUM_AGE,
  ageOn,
  eligibleOn,
  getAgeGateState,
  isUngatedPath,
  isValidBirthDate,
  minimumAgeFor,
  recordAgeAnswer,
} from "./age-gate";

/**
 * Review PLAN-C8 / PLAN-A7: three documents asserted an age gate that did not
 * exist. This is the gate. It is an attestation, not identity verification —
 * what it must actually guarantee is that the answer is asked once, kept, and
 * cannot be retried into a better one.
 */
let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db, { ageVerified: false });
  userId = user.id;
});

describe("the minimum by market", () => {
  it("is 21 in the US, 18 by default, and never a guess for a market we don't list", () => {
    expect(minimumAgeFor("US")).toBe(21);
    expect(minimumAgeFor("us")).toBe(21);
    expect(minimumAgeFor("GB")).toBe(DEFAULT_MINIMUM_AGE);
    // Unlisted falls back rather than throwing or inventing a number.
    expect(minimumAgeFor("ZZ")).toBe(DEFAULT_MINIMUM_AGE);
  });
});

describe("ageOn", () => {
  it("counts whole years by the calendar, including the birthday itself", () => {
    expect(ageOn("2000-06-15", new Date("2026-06-14T23:59:59Z"))).toBe(25);
    expect(ageOn("2000-06-15", new Date("2026-06-15T00:00:00Z"))).toBe(26);
  });

  it("does not drift on leap days, which dividing milliseconds does", () => {
    // 2004-02-29 → the day before the 21st birthday and the day of it.
    expect(ageOn("2004-02-29", new Date("2025-02-28T12:00:00Z"))).toBe(20);
    expect(ageOn("2004-02-29", new Date("2025-03-01T12:00:00Z"))).toBe(21);
  });
});

describe("isValidBirthDate", () => {
  it("takes an ISO date and refuses a date that doesn't exist", () => {
    expect(isValidBirthDate("1988-04-12")).toBe(true);
    expect(isValidBirthDate("2026-02-30")).toBe(false);
    expect(isValidBirthDate("1988-13-01")).toBe(false);
    expect(isValidBirthDate("12/04/1988")).toBe(false);
    expect(isValidBirthDate("")).toBe(false);
  });
});

describe("recordAgeAnswer", () => {
  it("lets an adult through and stores what applied at the time", async () => {
    const state = await recordAgeAnswer(
      db,
      userId,
      { birthDate: "1988-04-12", market: "US" },
      new Date("2026-09-03T00:00:00Z"),
    );
    expect(state.status).toBe("verified");

    const [row] = await db.select().from(schema.ageVerifications);
    expect(row).toMatchObject({ market: "US", minimumAge: 21, passed: true, eligibleOn: null });
  });

  it("blocks someone under the minimum and says when that stops being true", async () => {
    const state = await recordAgeAnswer(
      db,
      userId,
      { birthDate: "2008-01-20", market: "US" },
      new Date("2026-09-03T00:00:00Z"),
    );
    expect(state.status).toBe("blocked");
    // Eighteen in a 21 market: eligible on the 21st birthday, not never.
    expect(state).toMatchObject({ eligibleOn: "2029-01-20" });
  });

  it("applies the market's own minimum, so the same date passes in one and not another", async () => {
    const born = "2007-01-20";
    const now = new Date("2026-09-03T00:00:00Z");
    const other = await createTestUser(db, { ageVerified: false });

    await expect(recordAgeAnswer(db, userId, { birthDate: born, market: "GB" }, now)).resolves
      .toMatchObject({ status: "verified" });
    await expect(
      recordAgeAnswer(db, other.id, { birthDate: born, market: "US" }, now),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  /**
   * The one thing a self-reported gate must get right: a failing answer is
   * kept. Otherwise "I'm 19" is a free retry, and the gate is a quiz with
   * unlimited attempts.
   */
  it("keeps the first answer and refuses a second", async () => {
    const now = new Date("2026-09-03T00:00:00Z");
    await recordAgeAnswer(db, userId, { birthDate: "2010-01-20", market: "US" }, now);

    await expect(
      recordAgeAnswer(db, userId, { birthDate: "1980-01-20", market: "US" }, now),
    ).rejects.toBeInstanceOf(AgeAnswerAlreadyRecordedError);

    const rows = await db.select().from(schema.ageVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].birthDate).toBe("2010-01-20");
    expect((await getAgeGateState(db, userId, now)).status).toBe("blocked");
  });
});

describe("getAgeGateState", () => {
  it("is unknown until somebody answers", async () => {
    expect(await getAgeGateState(db, userId)).toEqual({ status: "unknown" });
  });

  /**
   * A block is until a birthday, not forever. Re-evaluating the stored answer
   * against today is what makes that true without ever rewriting the answer.
   */
  it("lets a blocked account through on the day it becomes eligible", async () => {
    await recordAgeAnswer(
      db,
      userId,
      { birthDate: "2008-01-20", market: "US" },
      new Date("2026-09-03T00:00:00Z"),
    );

    expect((await getAgeGateState(db, userId, new Date("2029-01-19T12:00:00Z"))).status).toBe(
      "blocked",
    );
    expect((await getAgeGateState(db, userId, new Date("2029-01-20T12:00:00Z"))).status).toBe(
      "verified",
    );
  });
});

describe("eligibleOn", () => {
  it("is the birthday the minimum lands on", () => {
    expect(eligibleOn("2008-01-20", 21)).toBe("2029-01-20");
    expect(eligibleOn("2008-02-29", 18)).toBe("2026-03-01"); // no 29 Feb in 2026
  });
});

describe("isUngatedPath", () => {
  it("exempts the gate, sign-in, the resources page and public share links", () => {
    expect(isUngatedPath("/age")).toBe(true);
    expect(isUngatedPath("/sign-in")).toBe(true);
    expect(isUngatedPath("/responsible")).toBe(true);
    expect(isUngatedPath("/s/abc123")).toBe(true);
    expect(isUngatedPath("/api/age")).toBe(true);
  });

  it("gates everything the app actually is", () => {
    for (const path of ["/", "/bar", "/pour", "/scan", "/search", "/chat", "/u/sasha", "/sharing"]) {
      expect(isUngatedPath(path)).toBe(false);
    }
    // Matched on whole segments, never as a bare prefix — a route named
    // carefully must not be a way around the gate.
    expect(isUngatedPath("/ages-of-whiskey")).toBe(false);
    expect(isUngatedPath("/signage")).toBe(false);
    expect(isUngatedPath("/september")).toBe(false);
  });
});
