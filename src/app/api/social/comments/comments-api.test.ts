import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, POST } from "@/app/api/social/comments/route";
import { DELETE, PATCH } from "@/app/api/social/comments/[id]/route";
import { createProfile } from "@/lib/social";
import { logPour } from "@/lib/pours";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/social/comments", () => {
  let db: DB;
  let author: schema.User;
  let commenter: schema.User;
  let pour: schema.Pour;

  beforeEach(async () => {
    db = await setupTestDb();
    author = await createTestUser(db, { name: "Author" });
    commenter = await createTestUser(db, { name: "Commenter" });
    const bottle = await createTestBottle(db);
    await createProfile(db, { id: author.id, name: author.name }, "author");
    await createProfile(db, { id: commenter.id, name: commenter.name }, "commenter");
    ({ pour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 4, visibility: "public" }));
    setSessionUser(commenter);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET(jsonRequest(`/api/social/comments?pourId=${pour.id}`, "GET"))).status).toBe(401);
    expect((await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "hi" }))).status).toBe(
      401,
    );
    expect((await PATCH(jsonRequest("/api/social/comments/x", "PATCH", { body: "hi" }), ctx("x"))).status).toBe(401);
    expect((await DELETE(jsonRequest("/api/social/comments/x", "DELETE"), ctx("x"))).status).toBe(401);
  });

  it("GET requires pourId and 404s for an unviewable pour", async () => {
    const missingParam = await GET(jsonRequest("/api/social/comments", "GET"));
    expect(missingParam.status).toBe(400);

    const bottle = await createTestBottle(db);
    const { pour: privatePour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 3 });
    const res = await GET(jsonRequest(`/api/social/comments?pourId=${privatePour.id}`, "GET"));
    expect(res.status).toBe(404);
  });

  it("POST returns 409 profile_required when the caller has no profile", async () => {
    const noProfile = await createTestUser(db);
    setSessionUser(noProfile);
    const res = await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "hi" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "profile_required" });
  });

  it("POST returns 400 for an empty body", async () => {
    const res = await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "" }));
    expect(res.status).toBe(400);
  });

  it("POST creates a comment, returns 201 CommentView; GET lists it", async () => {
    const res = await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "Great pour!" }));
    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.body).toBe("Great pour!");
    expect(comment.author.handle).toBe("commenter");
    expect(comment.canEdit).toBe(true);

    const listed = await GET(jsonRequest(`/api/social/comments?pourId=${pour.id}`, "GET"));
    expect(listed.status).toBe(200);
    expect((await listed.json()).items).toHaveLength(1);
  });

  it("POST returns 404 not_found for a missing parentId", async () => {
    const res = await POST(
      jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "reply", parentId: "ghost" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("PATCH edits a comment, 404 for a foreign editor", async () => {
    const created = await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "v1" }));
    const { id } = await created.json();

    const foreignRes = await PATCH(jsonRequest(`/api/social/comments/${id}`, "PATCH", { body: "v2" }), ctx("wrong"));
    expect(foreignRes.status).toBe(404);

    setSessionUser(author);
    const notAuthor = await PATCH(jsonRequest(`/api/social/comments/${id}`, "PATCH", { body: "hijack" }), ctx(id));
    expect(notAuthor.status).toBe(404);

    setSessionUser(commenter);
    const res = await PATCH(jsonRequest(`/api/social/comments/${id}`, "PATCH", { body: "v2" }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).body).toBe("v2");
  });

  it("DELETE soft-deletes a comment; author or pour owner may delete, 404 otherwise", async () => {
    const created = await POST(jsonRequest("/api/social/comments", "POST", { pourId: pour.id, body: "delete me" }));
    const { id } = await created.json();

    const other = await createTestUser(db);
    await createProfile(db, { id: other.id, name: other.name }, "rando");
    setSessionUser(other);
    const denied = await DELETE(jsonRequest(`/api/social/comments/${id}`, "DELETE"), ctx(id));
    expect(denied.status).toBe(404);

    setSessionUser(author); // pour owner may also delete
    const res = await DELETE(jsonRequest(`/api/social/comments/${id}`, "DELETE"), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const again = await DELETE(jsonRequest(`/api/social/comments/${id}`, "DELETE"), ctx(id));
    expect(again.status).toBe(404);
  });
});
