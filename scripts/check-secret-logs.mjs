#!/usr/bin/env node
// CI guard: fail when code or workflows print a secret to a log.
//
// Build output (Vercel) and Actions logs are long-lived and readable by anyone
// with project access, so a connection string or key printed there is a leak.
// Flags:
//   - console.* / process.std{out,err}.write calls that reference
//     process.env.<secret-ish name> (DATABASE_URL, *_SECRET, *_KEY, *TOKEN*,
//     *PASSWORD*) directly;
//   - in files that read the database URL, log calls that interpolate a raw
//     url variable (`${url}`, `${databaseUrl}`, …) instead of describeDbUrl();
//   - workflow `echo`/`printf` lines that print a secret (`${{ secrets.X }}`,
//     `$DATABASE_URL`, …) to the log rather than piping/redirecting it.
// Usage: node scripts/check-secret-logs.mjs [root]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME = String.raw`[A-Z0-9_]*(?:DATABASE_URL|SECRET|_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE)[A-Z0-9_]*`;
const ENV_SECRET = new RegExp(String.raw`process\.env(?:\.|\[\s*["'])(${SECRET_NAME})\b`);
const RAW_URL_INTERP = /\$\{\s*(url|dbUrl|databaseUrl|connectionString|connString|DATABASE_URL)\s*\}/;
const RAW_URL_ARG = /[(,]\s*(url|dbUrl|databaseUrl|connectionString|connString)\s*[,)]/;
const READS_DB_URL = /resolveDbUrl\(|process\.env\.DATABASE_URL|DATABASE_URL/;
const LOG_CALL = /\b(console\.(?:log|info|warn|error|debug|trace)|process\.std(?:out|err)\.write)\s*\(/g;
const SHELL_SECRET = new RegExp(
  String.raw`\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}|\$\{?(${SECRET_NAME})\}?`,
);

/** Text of each log call's argument list (balanced parens, multi-line). */
function logCalls(text) {
  const out = [];
  for (const m of text.matchAll(LOG_CALL)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push({ index: m.index, args: text.slice(start, i + 1) });
  }
  return out;
}

// Calls that only ever return a redacted value / a boolean — safe to log.
const SAFE_CALL = /\b(?:describeDbUrl|scrubDbUrl|formatDbError|isPostgresUrl|poolerMode)\s*\([^()]*\)/g;
const stripSafe = (args) => {
  let prev;
  do {
    prev = args;
    args = args.replace(SAFE_CALL, "SAFE");
  } while (args !== prev);
  return args;
};

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Findings for a JS/TS source file. */
export function scanCode(text, file = "<input>") {
  const findings = [];
  const readsDbUrl = READS_DB_URL.test(text);
  for (const { index, args: raw } of logCalls(text)) {
    const args = stripSafe(raw);
    const env = args.match(ENV_SECRET);
    if (env) {
      findings.push(`${file}:${lineOf(text, index)}: logs process.env.${env[1]} — log describeDbUrl()/a fixed message instead`);
      continue;
    }
    if (readsDbUrl && (RAW_URL_INTERP.test(args) || RAW_URL_ARG.test(args))) {
      findings.push(`${file}:${lineOf(text, index)}: logs a raw database URL — wrap it in describeDbUrl()`);
    }
  }
  return findings;
}

/** Findings for a GitHub Actions workflow / shell script. */
export function scanShell(text, file = "<input>") {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNo = i + 1;
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, " ") + lines[++i];
    const echo = line.match(/(?:^|[;&|]\s*|\s)(echo|printf)\s(.*)$/);
    if (!echo) continue;
    const rest = echo[2];
    // Output that goes to a pipe or a file (incl. $GITHUB_ENV) is not logged.
    if (/(^|[^<>])\|(?!\|)|>{1,2}\s*["$\/\w]/.test(rest.replace(/"[^"]*"|'[^']*'/g, (q) => q.replace(/[|>]/g, "")))) continue;
    if (/::add-mask::/.test(rest)) continue;
    const hit = rest.match(SHELL_SECRET);
    if (hit) findings.push(`${file}:${lineNo}: echoes ${hit[0]} to the log`);
  }
  return findings;
}

function walk(dir, exts, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".next")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.[cm]?[jt]sx?$/.test(name)) acc.push(full);
  }
  return acc;
}

export function scanRepo(root) {
  const findings = [];
  const rel = (f) => path.relative(root, f);
  for (const f of [...walk(path.join(root, "src"), [".ts", ".tsx", ".js", ".mjs"]), ...walk(path.join(root, "scripts"), [".ts", ".js", ".mjs", ".cjs"])]) {
    findings.push(...scanCode(readFileSync(f, "utf8"), rel(f)));
  }
  for (const f of [...walk(path.join(root, ".github", "workflows"), [".yml", ".yaml"]), ...walk(path.join(root, "scripts"), [".sh"])]) {
    findings.push(...scanShell(readFileSync(f, "utf8"), rel(f)));
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const findings = scanRepo(root);
  if (findings.length) {
    console.error(`✗ ${findings.length} place(s) print a secret to a log:\n  ${findings.join("\n  ")}`);
    process.exit(1);
  }
  console.log("✓ No secret/connection-string logging found");
}
