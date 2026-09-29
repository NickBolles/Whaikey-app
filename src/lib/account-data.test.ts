import { describe, expect, it } from "vitest";
import { Table, getTableName, is } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { strFromU8, unzipSync } from "fflate";

import * as schema from "@/db/schema";
import {
  ACCOUNT_DATA,
  NOT_LINKED,
  accountExportZip,
  csvCell,
  toCsv,
  type AccountExport,
} from "./account-data";

/**
 * The deletion and export policy against the schema — the same shape as the
 * `/privacy` inventory test, for the same reason: a table that ships without
 * anyone deciding what happens to it when its owner leaves is how an account
 * becomes "deleted" with half of itself still in the database. The schema is
 * asked, not scraped, so a table declared anywhere reaches this list.
 */
function schemaTables(): PgTable[] {
  return Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, Table));
}

describe("the account data policy against the schema", () => {
  it("decides every table: sliced in ACCOUNT_DATA or explained in NOT_LINKED", () => {
    const sliced = new Set(ACCOUNT_DATA.map((s) => getTableName(s.table)));
    const missing = schemaTables()
      .map((t) => getTableName(t))
      .filter((name) => !sliced.has(name) && !(name in NOT_LINKED));
    // If this fails you have added a table. Decide what an account deletion
    // does to it (deleted / unlinked / kept) and whether it is exported, and
    // add a slice to ACCOUNT_DATA — or, if it holds nothing about a person,
    // say why in NOT_LINKED. The route test then needs a fixture row for it.
    expect(missing).toEqual([]);
  });

  it("does not both slice a table and call it unlinked", () => {
    const sliced = new Set(ACCOUNT_DATA.map((s) => getTableName(s.table)));
    expect(Object.keys(NOT_LINKED).filter((t) => sliced.has(t))).toEqual([]);
  });

  it("carries no entries for tables that no longer exist", () => {
    const tables = new Set(schemaTables().map((t) => getTableName(t)));
    expect(Object.keys(NOT_LINKED).filter((t) => !tables.has(t))).toEqual([]);
  });

  it("slices every table that points at an account, whatever NOT_LINKED says", () => {
    // NOT_LINKED is a claim; a foreign key to `user` is the fact it has to
    // survive. A table with such a key cannot be declared unlinked.
    const sliced = new Set(ACCOUNT_DATA.map((s) => getTableName(s.table)));
    const pointsAtUser = schemaTables()
      .filter((t) =>
        getTableConfig(t).foreignKeys.some((fk) => getTableName(fk.reference().foreignTable) === "user"),
      )
      .map((t) => getTableName(t));
    expect(pointsAtUser.length).toBeGreaterThan(10);
    expect(pointsAtUser.filter((t) => !sliced.has(t))).toEqual([]);
  });

  it("gives every slice a unique key, a reason, and an export decision", () => {
    const keys = ACCOUNT_DATA.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const slice of ACCOUNT_DATA) {
      expect(slice.why.trim(), slice.key).not.toBe("");
      expect(slice.description.trim(), slice.key).not.toBe("");
      // Exactly one: exported with named columns, or a reason it is not.
      expect(Boolean(slice.export) !== Boolean(slice.notExported?.trim()), slice.key).toBe(true);
      // CSV file names and JSON keys; keep them boring.
      expect(slice.key, slice.key).toMatch(/^[a-z_]+$/);
    }
  });

  it("never names a credential column in an export", () => {
    // The columns that are keys rather than data. An export is a file that
    // travels, and each of these would let whoever holds it act as the account
    // or target its devices.
    const forbidden = ["token", "code", "codeHash", "sessionCookie", "phoneHash", "password", "accessToken", "refreshToken", "idToken", "clientId"];
    for (const slice of ACCOUNT_DATA) {
      const cols = slice.export?.columns ?? [];
      expect(cols.filter((c) => forbidden.includes(c)), slice.key).toEqual([]);
    }
  });
});

/** A strict RFC 4180 reader — the thing the export has to satisfy. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cell !== "") throw new Error(`stray quote at ${i}`);
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      throw new Error(`bare line break at ${i}`);
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (quoted) throw new Error("unterminated quote");
  if (cell !== "" || row.length) throw new Error("missing final CRLF");
  return rows;
}

describe("CSV", () => {
  it("quotes what needs quoting and nothing else", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "oak"')).toBe('"say ""oak"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(4.5)).toBe("4.5");
    expect(csvCell(false)).toBe("false");
    expect(csvCell(new Date("2026-09-01T12:00:00Z"))).toBe("2026-09-01T12:00:00.000Z");
    expect(csvCell({ vanilla: 3 })).toBe('"{""vanilla"":3}"');
  });

  it("defuses a text cell a spreadsheet would run as a formula, and leaves numbers alone", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("-vanilla")).toBe("'-vanilla");
    expect(csvCell(-2)).toBe("-2");
  });

  it("round-trips awkward text through a strict reader", () => {
    const rows = [
      { a: 'Vanilla, "caramel"\r\nand oak', b: 1 },
      { a: "", b: null },
    ];
    const parsed = parseCsv(toCsv(["a", "b"], rows));
    expect(parsed).toEqual([
      ["a", "b"],
      ['Vanilla, "caramel"\r\nand oak', "1"],
      ["", ""],
    ]);
  });

  it("zips one well-formed CSV per exported section, headers included when empty", () => {
    const exported: AccountExport = {
      format: "whaikey-account-export",
      version: 1,
      exportedAt: "2026-09-01T00:00:00.000Z",
      data: { pours: [{ id: "p1", rating: 4, bottleName: "Test, \"Quoted\"" }] },
      notIncluded: [{ section: "blocks_against_you", description: "d", why: "w" }],
    };
    const files = unzipSync(accountExportZip(exported));
    const exportedSlices = ACCOUNT_DATA.filter((s) => s.export);
    expect(Object.keys(files).sort()).toEqual(
      ["README.txt", ...exportedSlices.map((s) => `${s.key}.csv`)].sort(),
    );
    for (const slice of exportedSlices) {
      const bytes = files[`${slice.key}.csv`];
      // The UTF-8 byte-order mark, so a spreadsheet reads accents correctly.
      expect([...bytes.slice(0, 3)], slice.key).toEqual([0xef, 0xbb, 0xbf]);
      // strFromU8 decodes with TextDecoder, which consumes the mark.
      const [header, ...body] = parseCsv(strFromU8(bytes));
      expect(header).toEqual([...slice.export!.columns]);
      expect(body.every((r) => r.length === header.length), slice.key).toBe(true);
    }
    const pours = parseCsv(strFromU8(files["pours.csv"]));
    const cols = pours[0];
    expect(pours[1][cols.indexOf("bottleName")]).toBe('Test, "Quoted"');
    expect(strFromU8(files["README.txt"])).toContain("blocks_against_you");
  });
});
