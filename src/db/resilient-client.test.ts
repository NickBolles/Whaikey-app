import { afterEach, describe, expect, it, vi } from "vitest";
import { createResilientClient, describeQuery, poolerMode, withDbBudget, type PgClientLike, type PgQueryLike } from "./resilient-client";
import { hostedDbSettings } from "./index";

/**
 * A fake postgres-js client: `unsafe()` returns a lazy thenable (it only
 * "runs" on the first then, like postgres-js), whose settlement the test
 * controls. `end({ timeout: 0 })` rejects everything still pending.
 */
function fakeFactory() {
  const clients: Array<PgClientLike & { pending: Set<FakeQuery>; ended: boolean; executed: number }> = [];
  class FakeQuery implements PgQueryLike {
    executed = false;
    mode: "rows" | "values" = "rows";
    cancelled = 0;
    private resolveFn!: (v: unknown) => void;
    private rejectFn!: (e: unknown) => void;
    private readonly p = new Promise<unknown>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
    constructor(readonly owner: (typeof clients)[number], readonly text: string, readonly hangOnCancel = false) {}
    then<A = unknown, B = never>(onF?: ((v: unknown) => A | PromiseLike<A>) | null, onR?: ((e: unknown) => B | PromiseLike<B>) | null) {
      if (!this.executed) {
        this.executed = true;
        this.owner.executed += 1;
        this.owner.pending.add(this);
      }
      return this.p.then(onF, onR);
    }
    values() {
      this.mode = "values";
      return this;
    }
    cancel() {
      this.cancelled += 1;
      if (!this.hangOnCancel) this.fail(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
    }
    succeed(v: unknown) {
      this.owner.pending.delete(this);
      this.resolveFn(v);
    }
    fail(e: unknown) {
      this.owner.pending.delete(this);
      this.rejectFn(e);
    }
  }
  let hangOnCancel = false;
  const factory = () => {
    const c = Object.assign(() => undefined, {
      pending: new Set<FakeQuery>(),
      ended: false,
      executed: 0,
      options: { parsers: {} as Record<string, unknown>, serializers: {} as Record<string, unknown> },
      unsafe: (text: string) => new FakeQuery(c, text, hangOnCancel),
      begin: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      end: vi.fn(async () => {
        c.ended = true;
        for (const q of [...c.pending]) q.fail(new Error("CONNECTION_DESTROYED"));
      }),
    }) as unknown as PgClientLike & { pending: Set<FakeQuery>; ended: boolean; executed: number };
    clients.push(c);
    return c;
  };
  return { factory, clients, setHangOnCancel: (v: boolean) => (hangOnCancel = v) };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createResilientClient", () => {
  it("passes results through and keeps postgres-js laziness (values() before await)", async () => {
    const { factory, clients } = fakeFactory();
    const client = createResilientClient(factory, { queryTimeoutMs: 1000 });
    const q = client.unsafe("select 1", []) as unknown as { values: () => PromiseLike<unknown>; mode: string; executed: boolean };
    expect(q.executed).toBe(false);
    const v = q.values();
    expect((v as unknown as { mode: string }).mode).toBe("values");
    const pending = Promise.resolve(v);
    await flush();
    const [fq] = [...clients[0].pending];
    fq.succeed([[1]]);
    await expect(pending).resolves.toEqual([[1]]);
    expect(typeof client).toBe("function");
  });

  it("cancels a statement that outlives the watchdog, freeing the connection", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const events: string[] = [];
    const client = createResilientClient(factory, { queryTimeoutMs: 1000, graceMs: 500, onEvent: (e) => events.push(`${e.kind}:${e.query}`) });
    const p = Promise.resolve(client.unsafe("select   *\n from passport_tiers where user_id = $1", ["u"]));
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = (await settled) as { code?: string };
    expect(err.code).toBe("57014");
    expect(events).toEqual(["cancel:select * from passport_tiers where user_id = $1"]);
    expect(clients).toHaveLength(1);
    expect(client.resets()).toBe(0);
  });

  it("resets the pool when a cancelled query still never answers (dead socket)", async () => {
    vi.useFakeTimers();
    const { factory, clients, setHangOnCancel } = fakeFactory();
    setHangOnCancel(true);
    const client = createResilientClient(factory, { queryTimeoutMs: 1000, graceMs: 500 });
    clients[0].options.parsers["1184"] = "transparent";
    const stuck = Promise.resolve(client.unsafe("select 1", [])).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1600);
    expect(((await stuck) as Error).message).toBe("CONNECTION_DESTROYED");
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
    expect(client.resets()).toBe(1);
    // drizzle's parser tweaks survive the swap, and new queries use the new pool.
    expect(client.options.parsers["1184"]).toBe("transparent");
    setHangOnCancel(false);
    const next = Promise.resolve(client.unsafe("select 2", []));
    await flush();
    [...clients[1].pending][0].succeed("ok");
    await expect(next).resolves.toBe("ok");
  });

  it("does not arm a timer for queries that settle in time", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const events: string[] = [];
    const client = createResilientClient(factory, { queryTimeoutMs: 1000, onEvent: (e) => events.push(e.kind) });
    const p = Promise.resolve(client.unsafe("select 1", []));
    await flush();
    [...clients[0].pending][0].succeed(1);
    await p;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
  });

  it("widens the limit inside withDbBudget (enrichment cron scans)", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const events: string[] = [];
    const client = createResilientClient(factory, { queryTimeoutMs: 1000, onEvent: (e) => events.push(e.kind) });
    const run = withDbBudget(5000, async () => {
      const p = Promise.resolve(client.unsafe("select count(*) from bottles", []));
      return p;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);
    [...clients[0].pending][0].succeed(42);
    await expect(run).resolves.toBe(42);
  });

  it("disables the watchdog at 0", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const client = createResilientClient(factory, { queryTimeoutMs: 0 });
    const p = Promise.resolve(client.unsafe("select pg_sleep(600)", []));
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...clients[0].pending][0].cancelled).toBe(0);
    [...clients[0].pending][0].succeed(null);
    await p;
  });

  it("resets the pool when a transaction outlives its limit", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const client = createResilientClient(factory, { queryTimeoutMs: 1000, transactionTimeoutMs: 2000, graceMs: 500 });
    void client.begin(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(2600);
    expect(clients).toHaveLength(2);
    expect(clients[0].ended).toBe(true);
  });
});

describe("concurrency slots", () => {
  it("holds queries beyond the pool size until a slot frees, so nothing pipelines", async () => {
    const { factory, clients } = fakeFactory();
    const client = createResilientClient(factory, { queryTimeoutMs: 0, concurrency: 2, slotWaitMs: 60_000 });
    const ps = [1, 2, 3].map((n) => Promise.resolve(client.unsafe(`select ${n}`, [])));
    await flush();
    expect(clients[0].pending.size).toBe(2);
    [...clients[0].pending][0].succeed("a");
    await flush();
    await flush();
    expect(clients[0].executed).toBe(3);
    for (const q of [...clients[0].pending]) q.succeed("b");
    await expect(Promise.all(ps)).resolves.toHaveLength(3);
  });

  it("lets a waiter through after slotWaitMs instead of deadlocking", async () => {
    vi.useFakeTimers();
    const { factory, clients } = fakeFactory();
    const client = createResilientClient(factory, { queryTimeoutMs: 0, concurrency: 1, slotWaitMs: 2000 });
    void client.begin(() => new Promise(() => {}));
    await flush();
    const inner = Promise.resolve(client.unsafe("select 1", []));
    await flush();
    expect(clients[0].executed).toBe(0);
    await vi.advanceTimersByTimeAsync(2001);
    expect(clients[0].executed).toBe(1);
    [...clients[0].pending][0].succeed("ok");
    await expect(inner).resolves.toBe("ok");
  });
});

describe("hostedDbSettings", () => {
  it("defaults to a small pool, with the watchdog only on Vercel", () => {
    expect(hostedDbSettings({})).toEqual({ max: 4, queryTimeoutMs: 0, transactionTimeoutMs: 0 });
    expect(hostedDbSettings({ VERCEL: "1" })).toEqual({ max: 4, queryTimeoutMs: 15_000, transactionTimeoutMs: 45_000 });
  });

  it("honours overrides and clamps the pool", () => {
    expect(hostedDbSettings({ VERCEL: "1", DB_POOL_MAX: "50", DB_QUERY_TIMEOUT_MS: "8000" })).toMatchObject({ max: 10, queryTimeoutMs: 8000 });
    expect(hostedDbSettings({ DB_POOL_MAX: "0" }).max).toBe(1);
    expect(hostedDbSettings({ DB_POOL_MAX: "nope" }).max).toBe(4);
  });
});

describe("poolerMode / describeQuery", () => {
  it("classifies connection strings without echoing them", () => {
    expect(poolerMode("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres")).toBe("transaction");
    expect(poolerMode("postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres")).toBe("session");
    expect(poolerMode("postgres://u:p@db.example.supabase.co:5432/postgres")).toBe("direct");
    expect(poolerMode("not a url")).toBe("unknown");
  });

  it("collapses whitespace and truncates", () => {
    expect(describeQuery("select\n  1")).toBe("select 1");
    expect(describeQuery("x".repeat(500))).toHaveLength(120);
  });
});

describe("createDb (postgres-js options)", () => {
  it("bounds pipelining, keeps a small pool and recycles idle/old sockets", async () => {
    const { createDb, closeDb } = await import("./index");
    // No query is sent, so nothing connects.
    const db = createDb("postgres://u:p@127.0.0.1:6543/postgres");
    const client = (db as unknown as { $client: { options: Record<string, unknown> } }).$client;
    expect(typeof client).toBe("function");
    expect(client.options.max_pipeline).toBe(1);
    expect(client.options.max).toBe(4);
    expect(client.options.idle_timeout).toBe(20);
    expect(client.options.max_lifetime).toBe(300);
    expect(client.options.prepare).toBe(false);
    await closeDb(db);
  });
});
