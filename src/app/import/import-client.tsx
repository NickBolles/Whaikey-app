"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, FileUp, Loader2, Sparkles } from "lucide-react";
import { RELATIONSHIPS, type Relationship } from "@/db/schema";
import {
  FIELD_LABELS,
  IMPORT_FIELDS,
  heuristicMapping,
  normalizeImportRow,
  parseDelimited,
  type ColumnMapping,
  type NormalizedImportRow,
  type ParsedTable,
} from "@/lib/import";

/**
 * Spreadsheet/CSV import: paste or upload → confirm the (AI-proposed) column
 * mapping → confirm per-row bottle matches → commit. The user stays the
 * author at both confirm steps; rows they skip write nothing.
 */

interface MatchCandidate {
  id: string;
  name: string;
  distillery: string | null;
  category: string;
  via: "upc" | "name";
}

interface MatchRow {
  row: NormalizedImportRow;
  candidates: MatchCandidate[];
  /** Selected bottle id, or null to skip this row. */
  choice: string | null;
}

type Step = "input" | "mapping" | "match" | "done";

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  own: "I own these",
  tried: "Tried them",
  wishlist: "Wishlist",
};

const MAX_ROWS = 300;

export function ImportClient() {
  const [step, setStep] = useState<Step>("input");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [mappingSource, setMappingSource] = useState<"ai" | "heuristic">("heuristic");
  const [relationship, setRelationship] = useState<Relationship>("own");
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [summary, setSummary] = useState<{
    added: number;
    updated: number;
    upcsTaught: number;
    skipped: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const parseAndAnalyze = async (raw: string) => {
    setError(null);
    const parsed = parseDelimited(raw);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setError("Couldn't find a header row plus at least one data row in that file.");
      return;
    }
    if (parsed.rows.length > MAX_ROWS) {
      setError(`That's ${parsed.rows.length} rows — the importer takes up to ${MAX_ROWS} at a time.`);
      return;
    }
    setTable(parsed);
    setBusy(true);
    try {
      const res = await fetch("/api/import/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headers: parsed.headers, sampleRows: parsed.rows.slice(0, 5) }),
      });
      if (res.ok) {
        const data = (await res.json()) as { mapping: ColumnMapping; source: "ai" | "heuristic" };
        setMapping(data.mapping);
        setMappingSource(data.source);
      } else {
        setMapping(heuristicMapping(parsed.headers));
        setMappingSource("heuristic");
      }
    } catch {
      setMapping(heuristicMapping(parsed.headers));
      setMappingSource("heuristic");
    } finally {
      setBusy(false);
      setStep("mapping");
    }
  };

  const runMatch = async () => {
    if (!table || !mapping) return;
    if (mapping.name === null && mapping.upc === null) {
      setError("Map at least a bottle-name or UPC column so rows can be matched.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const normalized = table.rows.map((r) => normalizeImportRow(r, mapping, relationship));
      const res = await fetch("/api/import/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: normalized.map((r) => ({ name: r.name, upc: r.upc })) }),
      });
      if (!res.ok) throw new Error(`match failed (${res.status})`);
      const data = (await res.json()) as { results: Array<{ candidates: MatchCandidate[] }> };
      setRows(
        normalized.map((row, i) => ({
          row,
          candidates: data.results[i]?.candidates ?? [],
          choice: data.results[i]?.candidates[0]?.id ?? null,
        })),
      );
      setStep("match");
    } catch {
      setError("Matching failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    const items = rows
      .filter((r) => r.choice !== null)
      .map((r) => ({
        bottleId: r.choice!,
        relationship: r.row.relationship,
        status: r.row.status,
        fillLevel: r.row.fillLevel,
        quantity: r.row.quantity,
        purchasePrice: r.row.purchasePrice,
        purchaseDate: r.row.purchaseDate,
        store: r.row.store,
        location: r.row.location,
        notes: r.row.notes,
        upc: r.row.upc,
      }));
    if (items.length === 0) {
      setError("Every row is set to skip — pick at least one match to import.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`commit failed (${res.status})`);
      setSummary(await res.json());
      setStep("done");
    } catch {
      setError("Import failed — nothing may have been saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const matchedCount = rows.filter((r) => r.choice !== null).length;

  return (
    <div className="px-4 pt-6 flex flex-col gap-5 pb-6">
      <header>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">Import your collection</h1>
        <p className="text-muted text-sm mt-1">
          A CSV from your spreadsheet — or another app&apos;s export — becomes your bar.
        </p>
      </header>

      {error && (
        <p role="alert" className="card-flat px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {step === "input" && (
        <>
          <div className="card p-5 flex flex-col gap-3">
            <label htmlFor="import-paste" className="section-label">
              Paste CSV
            </label>
            <textarea
              id="import-paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder={"Bottle,UPC,Price Paid,Store\nEagle Rare 10,080244002145,39.99,Total Wine"}
              className="w-full rounded-xl border border-border-subtle bg-surface p-4 font-mono text-xs text-foreground placeholder:text-muted transition-colors focus:outline-none focus:border-accent/70"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || text.trim().length === 0}
                onClick={() => void parseAndAnalyze(text)}
                className="btn-primary flex-1 px-4 py-3 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
                Continue
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="btn-secondary px-4 py-3 text-sm font-medium flex items-center gap-2"
              >
                <FileUp size={16} strokeWidth={1.8} aria-hidden /> Upload file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
                className="hidden"
                aria-label="Upload a CSV file"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const content = await file.text();
                  setText(content);
                  void parseAndAnalyze(content);
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Columns are matched automatically (bottle, UPC, price paid, date, store, notes…) and you
            confirm everything before it lands. Up to {MAX_ROWS} rows at a time.
          </p>
        </>
      )}

      {step === "mapping" && table && mapping && (
        <>
          <div className="card p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="section-label">Column mapping</h2>
              <span className="chip px-3 py-1 text-xs flex items-center gap-1.5">
                {mappingSource === "ai" ? (
                  <>
                    <Sparkles size={12} aria-hidden className="text-accent" /> AI suggested
                  </>
                ) : (
                  "Auto-detected"
                )}
              </span>
            </div>
            <ul className="flex flex-col gap-3">
              {IMPORT_FIELDS.map((field) => (
                <li key={field} className="flex items-center justify-between gap-3">
                  <label htmlFor={`map-${field}`} className="text-sm min-w-0 truncate">
                    {FIELD_LABELS[field]}
                  </label>
                  <select
                    id={`map-${field}`}
                    value={mapping[field] ?? ""}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        [field]: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    className="rounded-xl border border-border-subtle bg-surface py-2 px-3 text-sm text-foreground max-w-[55%]"
                  >
                    <option value="">—</option>
                    {table.headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>

          <div className="card-flat p-4 flex flex-col gap-2">
            <span className="section-label">If a row doesn&apos;t say, treat it as</span>
            <div role="radiogroup" aria-label="Default relationship" className="flex gap-2">
              {RELATIONSHIPS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={relationship === r}
                  onClick={() => setRelationship(r)}
                  className={`chip min-h-11 px-4 text-sm font-medium ${
                    relationship === r ? "chip-active" : "hover:text-foreground"
                  }`}
                >
                  {RELATIONSHIP_LABELS[r]}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void runMatch()}
            className="btn-primary px-4 py-3.5 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <ArrowRight size={16} aria-hidden />
            )}
            Match {table.rows.length} row{table.rows.length === 1 ? "" : "s"}
          </button>
        </>
      )}

      {step === "match" && (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="section-label">
              Confirm matches ({matchedCount}/{rows.length})
            </h2>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li key={i} className="card-flat p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.row.name ?? r.row.upc ?? `Row ${i + 1}`}</div>
                    <div className="text-xs text-muted mt-0.5 truncate">
                      {[
                        r.row.purchasePrice != null ? `$${r.row.purchasePrice}` : null,
                        r.row.store,
                        r.row.upc,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "no extra columns"}
                    </div>
                  </div>
                  {r.candidates[0]?.via === "upc" && (
                    <span className="chip px-2.5 py-1 text-[10px] shrink-0">via UPC</span>
                  )}
                </div>
                <select
                  aria-label={`Match for ${r.row.name ?? `row ${i + 1}`}`}
                  value={r.choice ?? ""}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((p, pi) =>
                        pi === i ? { ...p, choice: e.target.value === "" ? null : e.target.value } : p,
                      ),
                    )
                  }
                  className="rounded-xl border border-border-subtle bg-surface py-2.5 px-3 text-sm text-foreground"
                >
                  <option value="">Skip this row</option>
                  {r.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.distillery ? ` — ${c.distillery}` : ""}
                    </option>
                  ))}
                </select>
                {r.candidates.length === 0 && (
                  <p className="text-xs text-muted">
                    No catalog match — this row will be skipped. Add it later via search or scan.
                  </p>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            onClick={() => void commit()}
            className="btn-primary px-4 py-3.5 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
            Import {matchedCount} bottle{matchedCount === 1 ? "" : "s"}
          </button>
        </>
      )}

      {step === "done" && summary && (
        <div className="card p-8 text-center flex flex-col items-center gap-3">
          <div aria-hidden className="text-4xl">🥃</div>
          <p className="font-display text-xl font-semibold">Collection imported</p>
          <p className="text-sm text-muted leading-relaxed max-w-xs">
            {summary.added} added, {summary.updated} updated
            {summary.upcsTaught > 0 ? `, ${summary.upcsTaught} barcode${summary.upcsTaught === 1 ? "" : "s"} learned` : ""}
            {summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}.
          </p>
          <div className="flex gap-2 mt-2">
            <Link href="/bar" className="btn-primary px-5 py-2.5 text-sm font-medium">
              See My Bar
            </Link>
            <button
              type="button"
              onClick={() => {
                setStep("input");
                setText("");
                setTable(null);
                setMapping(null);
                setRows([]);
                setSummary(null);
              }}
              className="btn-secondary px-5 py-2.5 text-sm font-medium"
            >
              Import another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
