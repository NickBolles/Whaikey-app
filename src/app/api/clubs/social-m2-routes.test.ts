import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { createProfile } from "@/lib/social";
import { GET as LIST_CLUBS, POST as CREATE_CLUB } from "@/app/api/clubs/route";
import { DELETE as DELETE_CLUB, PATCH as PATCH_CLUB } from "@/app/api/clubs/[id]/route";
import { POST as INVITE } from "@/app/api/clubs/[id]/invites/route";
import { DELETE as REVOKE } from "@/app/api/clubs/invites/[code]/route";
import { POST as JOIN_CLUB } from "@/app/api/clubs/join/route";
import { DELETE as REMOVE, PATCH as ROLE } from "@/app/api/clubs/[id]/members/[userId]/route";
import { POST as CLUB_CHALLENGE } from "@/app/api/clubs/[id]/challenges/route";
import { DELETE as LEAVE_CHALLENGE, POST as JOIN_CHALLENGE } from "@/app/api/challenges/[slug]/route";
import { POST as BOARD } from "@/app/api/challenges/board/route";
import { GET as LIST_FLIGHTS, POST as CREATE_FLIGHT } from "@/app/api/flights/route";
import { GET as STATE } from "@/app/api/flights/[code]/state/route";
import { GET as ICS } from "@/app/api/flights/[code]/ics/route";
import { GET as EXPORT } from "@/app/api/flights/[code]/export/route";
import { POST as CLAIM } from "@/app/api/flights/[code]/claim/route";
import { POST as HIDE } from "@/app/api/flights/[code]/entries/[entryId]/hide/route";
import { POST as JOIN_FLIGHT } from "@/app/api/flights/join/route";

const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

async function person(db: DB, handle: string) {
  const u = await createTestUser(db, { name: handle });
  await createProfile(db, u, handle);
  return u;
}

describe("club routes", () => {
  let db: DB;
  let owner: schema.User;
  let other: schema.User;
  beforeEach(async () => {
    db = await setupTestDb();
    owner = await person(db, "owner_rt");
    other = await person(db, "other_rt");
    setSessionUser(owner);
  });

  it("401s signed out across the surface", async () => {
    setSessionUser(null);
    expect((await LIST_CLUBS()).status).toBe(401);
    expect((await CREATE_CLUB(jsonRequest("/api/clubs", "POST", { name: "x" }))).status).toBe(401);
    expect((await JOIN_CLUB(jsonRequest("/", "POST", { code: "abc" }))).status).toBe(401);
    expect((await BOARD(jsonRequest("/", "POST", { optIn: true }))).status).toBe(401);
    expect((await LIST_FLIGHTS()).status).toBe(401);
  });

  it("create → patch → invite → join → role → remove → revoke → delete, with 400/404/409 edges", async () => {
    expect((await CREATE_CLUB(jsonRequest("/api/clubs", "POST", { name: "" }))).status).toBe(400);
    const noProfile = await createTestUser(db);
    setSessionUser(noProfile);
    expect((await CREATE_CLUB(jsonRequest("/api/clubs", "POST", { name: "Nope" }))).status).toBe(409);
    setSessionUser(owner);
    const created = await CREATE_CLUB(jsonRequest("/api/clubs", "POST", { name: "Route Club" }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(((await (await LIST_CLUBS()).json()) as { items: unknown[] }).items).toHaveLength(1);

    expect((await PATCH_CLUB(jsonRequest("/", "PATCH", { bogus: 1 }), p({ id }))).status).toBe(400);
    expect((await PATCH_CLUB(jsonRequest("/", "PATCH", { description: "Hi" }), p({ id }))).status).toBe(200);

    const inv = await INVITE(jsonRequest("/", "POST"), p({ id }));
    expect(inv.status).toBe(201);
    const { code } = (await inv.json()) as { code: string };

    setSessionUser(other);
    expect((await PATCH_CLUB(jsonRequest("/", "PATCH", { name: "Mine" }), p({ id }))).status).toBe(404);
    expect((await INVITE(jsonRequest("/", "POST"), p({ id }))).status).toBe(404);
    expect((await JOIN_CLUB(jsonRequest("/", "POST", {}))).status).toBe(400);
    expect((await JOIN_CLUB(jsonRequest("/", "POST", { code: "zzzzzzzz" }))).status).toBe(404);
    expect((await JOIN_CLUB(jsonRequest("/", "POST", { code }))).status).toBe(200);
    expect((await REVOKE(jsonRequest("/", "DELETE"), p({ code }))).status).toBe(404);
    expect((await ROLE(jsonRequest("/", "PATCH", { role: "admin" }), p({ id, userId: owner.id }))).status).toBe(404);
    expect((await DELETE_CLUB(jsonRequest("/", "DELETE"), p({ id }))).status).toBe(404);

    setSessionUser(owner);
    expect((await ROLE(jsonRequest("/", "PATCH", { role: "boss" }), p({ id, userId: other.id }))).status).toBe(400);
    expect((await ROLE(jsonRequest("/", "PATCH", { role: "admin" }), p({ id, userId: other.id }))).status).toBe(200);
    expect((await CLUB_CHALLENGE(jsonRequest("/", "POST", { title: "x" }), p({ id }))).status).toBe(400);
    const ch = await CLUB_CHALLENGE(jsonRequest("/", "POST", { title: "Two styles", rule: { kind: "distinct_styles", target: 2 }, days: 14 }), p({ id }));
    expect(ch.status).toBe(201);
    const { slug } = (await ch.json()) as { slug: string };
    expect((await JOIN_CHALLENGE(jsonRequest("/", "POST"), p({ slug }))).status).toBe(200);
    expect((await LEAVE_CHALLENGE(jsonRequest("/", "DELETE"), p({ slug }))).status).toBe(200);
    expect((await JOIN_CHALLENGE(jsonRequest("/", "POST"), p({ slug: "nope" }))).status).toBe(404);
    expect((await LEAVE_CHALLENGE(jsonRequest("/", "DELETE"), p({ slug: "nope" }))).status).toBe(404);
    expect((await BOARD(jsonRequest("/", "POST", { optIn: "yes" }))).status).toBe(400);
    expect((await BOARD(jsonRequest("/", "POST", { optIn: true }))).status).toBe(200);

    expect((await REMOVE(jsonRequest("/", "DELETE"), p({ id, userId: other.id }))).status).toBe(200);
    expect((await REMOVE(jsonRequest("/", "DELETE"), p({ id, userId: other.id }))).status).toBe(404);
    expect((await REVOKE(jsonRequest("/", "DELETE"), p({ code }))).status).toBe(200);
    expect((await DELETE_CLUB(jsonRequest("/", "DELETE"), p({ id }))).status).toBe(200);
    expect(await db.query.clubs.findFirst({ where: eq(schema.clubs.id, id) })).toBeUndefined();
  });
});

describe("flight routes", () => {
  let db: DB;
  let host: schema.User;
  let code: string;
  beforeEach(async () => {
    db = await setupTestDb();
    host = await person(db, "host_rt");
    setSessionUser(host);
    const bs = [await createTestBottle(db), await createTestBottle(db), await createTestBottle(db)];
    const res = await CREATE_FLIGHT(
      jsonRequest("/api/flights", "POST", { title: "Route night", bottleIds: bs.map((b) => b.id), scheduledAt: "2026-11-01T19:00:00Z" }),
    );
    code = ((await res.json()) as { joinCode: string }).joinCode;
  });

  it("covers state, ics, export, claim, hide and join edges", async () => {
    expect(((await (await LIST_FLIGHTS()).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await STATE(jsonRequest("/", "GET"), p({ code }))).status).toBe(200);
    expect((await STATE(jsonRequest("/", "GET"), p({ code: "nosuchcode" }))).status).toBe(404);
    expect((await ICS(new Request(`http://localhost/api/flights/${code}/ics`), p({ code }))).status).toBe(200);
    expect((await ICS(new Request("http://localhost/x"), p({ code: "nosuchcode" }))).status).toBe(404);
    expect((await EXPORT(new Request("http://localhost/x"), p({ code }))).status).toBe(409); // not revealed
    expect((await EXPORT(new Request("http://localhost/x"), p({ code: "nosuchcode" }))).status).toBe(404);
    expect((await CLAIM(new Request("http://localhost/x", { method: "POST" }), p({ code }))).status).toBe(404);
    expect((await HIDE(jsonRequest("/", "POST"), p({ code, entryId: "nope" }))).status).toBe(404);
    expect((await JOIN_FLIGHT(jsonRequest("/", "POST", { bogus: true }))).status).toBe(400);
    expect((await JOIN_FLIGHT(jsonRequest("/", "POST", { code: "nosuchcode" }))).status).toBe(404);
    expect((await JOIN_FLIGHT(jsonRequest("/", "POST", { code }))).status).toBe(200);

    const noProfile = await createTestUser(db);
    setSessionUser(noProfile);
    expect((await JOIN_FLIGHT(jsonRequest("/", "POST", { code }))).status).toBe(409);
    expect((await CREATE_FLIGHT(jsonRequest("/api/flights", "POST", { title: "Night", bottleIds: ["a", "b", "c"] }))).status).toBe(409);
    setSessionUser(null);
    expect((await EXPORT(new Request("http://localhost/x"), p({ code }))).status).toBe(404);
  });
});
