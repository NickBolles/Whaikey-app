"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export interface ClaimView {
  upc: string;
  bottleId: string;
  bottleName: string;
  votes: number;
  eligibleVotes: number;
  competing: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Operator table for barcode claims; plain like the other admin tools.
 * `published` lists live crowd mappings: reject only (withdraws the mapping).
 */
export function BarcodeClaims({ claims, published = false }: { claims: ClaimView[]; published?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject", c: ClaimView) {
    const key = `${c.upc}:${c.bottleId}`;
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/scan/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, upc: c.upc, bottleId: c.bottleId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (claims.length === 0)
    return <p className="text-xs text-muted">{published ? "No crowd-published barcodes." : "No pending claims."}</p>;
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <table className="w-full text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-3 text-left font-normal">Barcode</th>
            <th className="py-1 pr-3 text-left font-normal">Bottle</th>
            <th className="py-1 pr-3 text-right font-normal">Claims (eligible)</th>
            <th className="py-1 pr-3 text-right font-normal">Competing</th>
            <th className="py-1 pr-3 text-right font-normal">Last</th>
            <th className="py-1 text-right font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => {
            const key = `${c.upc}:${c.bottleId}`;
            return (
              <tr key={key} className="border-t border-border-subtle">
                <td className="py-1 pr-3 font-mono">{c.upc}</td>
                <td className="py-1 pr-3">
                  <Link href={`/bottles/${c.bottleId}`} className="text-accent hover:underline">
                    {c.bottleName}
                  </Link>
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {c.votes} ({c.eligibleVotes})
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.competing || "–"}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{c.lastAt.slice(0, 10)}</td>
                <td className="py-1 text-right whitespace-nowrap">
                  {!published && (
                    <button
                      type="button"
                      disabled={busy === key}
                      onClick={() => act("approve", c)}
                      className="tap-target px-2 text-accent hover:underline disabled:opacity-50"
                    >
                      Approve
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy === key}
                    onClick={() => act("reject", c)}
                    className="tap-target px-2 text-danger hover:underline disabled:opacity-50"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
