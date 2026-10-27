import { describe, expect, it } from "vitest";
import path from "node:path";
import { describeDbUrl, formatDbError, scrubDbUrl } from "./redact";
// The CI guard (scripts/check-secret-logs.mjs) — tested here so vitest's
// src-only include picks it up.
import { scanCode, scanRepo, scanShell } from "../../scripts/check-secret-logs.mjs";

const PASSWORD = "fake-Pa55word-for-tests";
const URL_WITH_PASSWORD = `postgresql://postgres.abcdefgh:${PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&password=${PASSWORD}`;

describe("describeDbUrl", () => {
  it("keeps only scheme, host, port and database name", () => {
    expect(describeDbUrl(URL_WITH_PASSWORD)).toBe("postgresql://***@aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  });

  it("never contains the user or password", () => {
    const out = describeDbUrl(URL_WITH_PASSWORD);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain("postgres.abcdefgh");
    expect(out).not.toContain("sslmode");
  });

  it("handles URLs without credentials, port or database", () => {
    expect(describeDbUrl("postgres://db.internal")).toBe("postgres://db.internal");
    expect(describeDbUrl("postgres://u@db.internal:5432/app")).toBe("postgres://***@db.internal:5432/app");
  });

  it("handles percent-encoded passwords", () => {
    const out = describeDbUrl("postgres://u:p%40ss%3Aw0rd@h:5432/d");
    expect(out).toBe("postgres://***@h:5432/d");
    expect(out).not.toContain("p%40ss");
  });

  it("returns local PGlite paths unchanged", () => {
    expect(describeDbUrl("/w/data/whaikey")).toBe("/w/data/whaikey");
    expect(describeDbUrl(":memory:")).toBe(":memory:");
  });

  it("never echoes back an unparseable credential-bearing value", () => {
    expect(describeDbUrl("postgres://u:pw@[bad")).toBe("(unparseable database url)");
    expect(describeDbUrl("u:pw@host/db")).toBe("(unparseable database url)");
    expect(describeDbUrl(undefined)).toBe("(no database url)");
    expect(describeDbUrl("")).toBe("(no database url)");
  });
});

describe("scrubDbUrl / formatDbError", () => {
  it("replaces the full URL and the bare password in error text", () => {
    const text = `connect failed for ${URL_WITH_PASSWORD} (password ${PASSWORD})`;
    const out = scrubDbUrl(text, URL_WITH_PASSWORD);
    expect(out).not.toContain(PASSWORD);
    expect(out).toContain("aws-0-us-east-1.pooler.supabase.com:6543/postgres");
  });

  it("scrubs Error stacks and non-Error values", () => {
    const err = new Error(`boom ${URL_WITH_PASSWORD}`);
    expect(formatDbError(err, URL_WITH_PASSWORD)).not.toContain(PASSWORD);
    expect(formatDbError(`raw ${PASSWORD}`, URL_WITH_PASSWORD)).toBe("raw ***");
    expect(formatDbError("plain", undefined)).toBe("plain");
  });
});

describe("check-secret-logs guard", () => {
  it("flags logging process.env secrets directly", () => {
    expect(scanCode("console.log(process.env.DATABASE_URL);")).toHaveLength(1);
    expect(scanCode("console.info(`key=${process.env.OPENAI_API_KEY}`);")).toHaveLength(1);
    expect(scanCode("console.error('x', process.env['BETTER_AUTH_SECRET'])")).toHaveLength(1);
    expect(scanCode("process.stdout.write(process.env.GITHUB_TOKEN + '\\n')")).toHaveLength(1);
  });

  it("flags a raw db url interpolated in a file that reads DATABASE_URL", () => {
    const src = "const url = resolveDbUrl();\nconsole.log(\n  `Migrated ${url}`,\n);";
    expect(scanCode(src)).toEqual(["<input>:2: logs a raw database URL — wrap it in describeDbUrl()"]);
    expect(scanCode("const url = resolveDbUrl();\nconsole.log('Migrated', url);")).toHaveLength(1);
  });

  it("allows redacted or message-only logging", () => {
    expect(scanCode("const url = resolveDbUrl();\nconsole.log(`Migrated ${describeDbUrl(url)}`);")).toEqual([]);
    expect(scanCode("const url = resolveDbUrl();\nconsole.error(formatDbError(err, process.env.DATABASE_URL));")).toEqual([]);
    expect(scanCode('console.warn("DATABASE_URL is not set");')).toEqual([]);
    // url logging in files that never touch the database (e.g. the native shell URL)
    expect(scanCode("console.log(`will load ${url}`);")).toEqual([]);
  });

  it("flags workflow echoes of secrets but not piped/redirected ones", () => {
    expect(scanShell('          echo "url=$DATABASE_URL"')).toHaveLength(1);
    expect(scanShell("          echo ${{ secrets.ANTHROPIC_API_KEY }}")).toHaveLength(1);
    expect(scanShell('          echo "${{ secrets.KEYSTORE_B64 }}" | base64 --decode \\\n            > "$RUNNER_TEMP/k"')).toEqual([]);
    expect(scanShell('          echo "KEYCHAIN_PASSWORD=$(openssl rand -base64 24)" >> "$GITHUB_ENV"')).toEqual([]);
    expect(scanShell('          echo "::error::DATABASE_URL secret is not set"')).toEqual([]);
  });

  it("finds nothing in this repository", () => {
    expect(scanRepo(path.resolve(__dirname, "../.."))).toEqual([]);
  });
});
