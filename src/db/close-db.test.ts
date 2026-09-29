import { describe, expect, it, vi } from "vitest";
import { closeDb, type DB } from "./index";

// closeDb is what lets a one-shot script (verify-sold, feedback:review) exit
// instead of hanging on an open socket. postgres-js's client is the `sql`
// tagged-template *function*; an object-only check silently skipped it, which
// the Postgres CI lane (review REL-8.2) surfaced as a template database that
// was still "being accessed by other users" after being closed.

function withClient(client: unknown): DB {
  return { $client: client } as unknown as DB;
}

describe("closeDb", () => {
  it("ends a postgres-js client, which is a function with an end() method", async () => {
    const end = vi.fn(async () => {});
    const sql = Object.assign(() => {}, { end });
    await closeDb(withClient(sql));
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes a PGlite client, which is an object with close()", async () => {
    const close = vi.fn(async () => {});
    await closeDb(withClient({ close }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("prefers end() when a client has both", async () => {
    const end = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    await closeDb(withClient({ end, close }));
    expect(end).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("is a no-op for a handle without a client", async () => {
    await expect(closeDb(withClient(undefined))).resolves.toBeUndefined();
    await expect(closeDb(withClient("nope"))).resolves.toBeUndefined();
  });
});
