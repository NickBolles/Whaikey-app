import type { OutingInsights, Recognition } from "@/lib/outings/insights";

/**
 * The outing's live insights: who tastes alike, whose notes to learn from,
 * the favourite and the most divisive bottle, and what the group agreed on.
 * Typographic, no badges or confetti (docs/DESIGN.md, Ledger × Paper). It
 * says plainly when there isn't enough to say yet.
 */
export function OutingInsightsPanel({ insights }: { insights: OutingInsights | null }) {
  if (!insights) return null;
  const rows: Array<{ k: string; title: string; value: string; why?: string }> = [];
  if (insights.closest) rows.push({ k: "closest", title: "Your closest palate", value: insights.closest.name, why: insights.closest.why });
  if (insights.twins) rows.push({ k: "twins", title: "Palate twins", value: `${insights.twins.aName} & ${insights.twins.bName}`, why: insights.twins.why });
  if (insights.learnFrom) rows.push({ k: "learn", title: `Learn from ${insights.learnFrom.name}`, value: "", why: insights.learnFrom.why });
  if (insights.favourite) rows.push({ k: "fav", title: "Group favourite so far", value: insights.favourite.label, why: `${insights.favourite.average.toFixed(1)} stars from ${insights.favourite.raters} people.` });
  if (insights.divisive) rows.push({ k: "div", title: "Most divisive", value: insights.divisive.label, why: insights.divisive.why });
  if (insights.calledIt) rows.push({ k: "called", title: "Called it", value: insights.calledIt.name, why: insights.calledIt.why });
  return (
    <section aria-labelledby="insights-heading" className="flex flex-col gap-2">
      <h2 id="insights-heading" className="section-label">
        What the group is finding
      </h2>
      {insights.waiting && rows.length === 0 && insights.agreed.length === 0 ? (
        <p className="text-sm text-muted">{insights.waiting}</p>
      ) : (
        <dl className="card-flat grid gap-3 p-3 sm:grid-cols-2">
          {rows.map((r) => (
            <div key={r.k} className="flex flex-col gap-0.5" data-insight={r.k}>
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">{r.title}</dt>
              {r.value && <dd className="font-display text-base font-semibold leading-tight">{r.value}</dd>}
              {r.why && <dd className="text-xs text-foreground/80">{r.why}</dd>}
            </div>
          ))}
          {insights.agreed.length > 0 && (
            <div className="flex flex-col gap-0.5 sm:col-span-2" data-insight="agreed">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted">Notes the group agreed on</dt>
              {insights.agreed.map((b) => (
                <dd key={b.key} className="text-xs">
                  <span className="font-medium">{b.label}:</span> {b.tags.join(" · ")}
                </dd>
              ))}
            </div>
          )}
        </dl>
      )}
      {!insights.closest && !insights.waiting && <p className="text-xs text-muted">Rate two of the same bottles as someone else to see whose palate is closest to yours.</p>}
    </section>
  );
}

/** The recap's earned recognitions: small cards, about tasting and notes only. */
export function OutingRecognitions({ items }: { items: Recognition[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="section-label">Recognitions</h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((r) => (
          <li key={r.id} className="card-flat flex flex-col gap-0.5 border-l-2 border-accent p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-accent">{r.title}</span>
            <span className="font-display text-base font-semibold leading-tight">{r.who}</span>
            <span className="text-xs text-foreground/80">{r.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
