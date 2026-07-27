/**
 * Minimal RFC-4180 CSV parsing shared by the price-list adapters (Oregon,
 * BC). Handles quoted fields containing commas/newlines and doubled quotes.
 * The TTB COLA adapter keeps its own parser: historic COLA exports violate
 * RFC 4180 in ways that need source-specific repair (see cola.ts).
 */

/** Parse CSV text into rows of raw cell strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text whose first row is a header into keyed records. A BOM on the
 * first header cell is stripped (BC's export ships one).
 */
export function parseCsvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h, i) => (i === 0 ? h.replace(/^﻿/, "") : h).trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = cells[i] ?? "";
    });
    return record;
  });
}
