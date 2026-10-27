/**
 * Safe-to-log descriptions of a database connection string.
 *
 * A Postgres URL carries the password (`postgres://user:pass@host:port/db`),
 * and anything printed by a build or script ends up in Vercel / GitHub Actions
 * logs that outlive the credential. Never log a connection string directly —
 * log `describeDbUrl(url)` instead (CI enforces this: scripts/check-secret-logs.mjs).
 */

const POSTGRES_SCHEME = /^postgres(ql)?:/i;

/**
 * `postgres://user:pass@db.example.com:6543/postgres?sslmode=require`
 *   → `postgres://***@db.example.com:6543/postgres`
 *
 * User, password, query string and fragment are dropped (query params can hold
 * credentials too). Non-URL values (a local PGlite directory or `:memory:`) are
 * not secrets and are returned unchanged. A postgres-looking value that does not
 * parse is never echoed back.
 */
export function describeDbUrl(url: string | undefined | null): string {
  if (!url) return "(no database url)";
  const trimmed = url.trim();
  if (!POSTGRES_SCHEME.test(trimmed) && !trimmed.includes("://")) {
    // A filesystem path / :memory: (PGlite). Still refuse anything with an
    // embedded credential marker.
    return /@/.test(trimmed) ? "(unparseable database url)" : trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "(unparseable database url)";
  }
  const auth = parsed.username || parsed.password ? "***@" : "";
  const port = parsed.port ? `:${parsed.port}` : "";
  const db = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}${db}`;
}

/**
 * Replace every occurrence of the raw URL (and of its password, which drivers
 * sometimes echo on its own) in `text` with the redacted form. Use it on error
 * messages / stacks before printing them.
 */
export function scrubDbUrl(text: string, url: string | undefined | null): string {
  if (!url) return text;
  let out = text.split(url).join(describeDbUrl(url));
  try {
    const parsed = new URL(url.trim());
    for (const secret of [parsed.password, decodeURIComponent(parsed.password)]) {
      if (secret && secret.length >= 4) out = out.split(secret).join("***");
    }
  } catch {
    // not a URL — nothing more to scrub
  }
  return out;
}

/** Format an unknown thrown value for logging with the DB URL scrubbed out. */
export function formatDbError(err: unknown, url: string | undefined | null): string {
  const text = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return scrubDbUrl(text, url);
}
