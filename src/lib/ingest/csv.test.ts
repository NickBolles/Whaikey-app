import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./csv";

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes, and CRLF", () => {
    const rows = parseCsv('"a,b","say ""hi""",plain\r\nnext,1,2\n');
    expect(rows).toEqual([
      ["a,b", 'say "hi"', "plain"],
      ["next", "1", "2"],
    ]);
  });

  it("handles quoted newlines inside a field", () => {
    const rows = parseCsv('"line1\nline2",x\n');
    expect(rows).toEqual([["line1\nline2", "x"]]);
  });

  it("skips blank lines and keeps a trailing unterminated row", () => {
    const rows = parseCsv("a,b\n\nc,d");
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseCsvRecords", () => {
  it("keys rows by header and strips a BOM", () => {
    const records = parseCsvRecords("﻿Name,Price\nLagavulin 16,109.99\n");
    expect(records).toEqual([{ Name: "Lagavulin 16", Price: "109.99" }]);
  });

  it("fills missing trailing cells with empty strings", () => {
    const records = parseCsvRecords("A,B,C\n1,2\n");
    expect(records).toEqual([{ A: "1", B: "2", C: "" }]);
  });
});
