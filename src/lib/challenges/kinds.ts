import type { ChallengeRule } from "@/db/schema";
import { leafLabel } from "@/lib/flavor-wheel";

/**
 * The closed list of challenge rule kinds (docs/SOCIAL.md D16). Pure and
 * client-safe. Every kind maps a met bottle to the DISTINCT keys it
 * contributes — never a quantity — and progress is a set size capped at the
 * target. `challenges.test.ts` is the lint test that holds this line.
 */
export interface MetRow {
  bottleId: string;
  distilleryId: string | null;
  country: string | null;
  region: string | null;
  category: string;
  caskTypes: string[] | null;
  flavorTags: Record<string, number> | null;
}

export interface RuleKind {
  label: string;
  /** What one "distinct thing" is, for the copy: "countries", "distilleries". */
  noun: string;
  /** The distinct keys one met bottle contributes. Never a quantity. */
  distinctOf: (row: MetRow) => string[];
  /** Filters a rule may carry, and what they match on. */
  filters: ReadonlyArray<"country" | "region" | "category">;
}

const one = (v: string | null | undefined) => (v ? [v] : []);

export const RULE_KINDS = {
  distinct_countries: { label: "Countries", noun: "countries", distinctOf: (r) => one(r.country), filters: ["category"] },
  distinct_regions: { label: "Regions", noun: "regions", distinctOf: (r) => one(r.region), filters: ["country"] },
  distinct_distilleries: {
    label: "Distilleries",
    noun: "distilleries",
    distinctOf: (r) => one(r.distilleryId),
    filters: ["country", "region", "category"],
  },
  distinct_cask_types: {
    label: "Cask types",
    noun: "cask types",
    distinctOf: (r) => (r.caskTypes ?? []).map((c) => c.toLowerCase().trim()).filter(Boolean),
    filters: ["country", "category"],
  },
  distinct_styles: { label: "Styles", noun: "styles", distinctOf: (r) => one(r.category), filters: ["country"] },
  distinct_descriptors: {
    label: "Descriptors",
    noun: "descriptors",
    distinctOf: (r) => Object.keys(r.flavorTags ?? {}).filter((k) => leafLabel(k) != null),
    filters: [],
  },
} as const satisfies Record<string, RuleKind>;

export type RuleKindId = keyof typeof RULE_KINDS;
export const RULE_KIND_IDS = Object.keys(RULE_KINDS) as RuleKindId[];
export const MAX_TARGET = 25;

/** Progress: distinct keys met, capped at the target. Pure, so it is what the lint test exercises. */
export function progressFor(rule: ChallengeRule, rows: MetRow[]): { count: number; target: number; met: string[] } {
  const kind = RULE_KINDS[rule.kind as RuleKindId];
  if (!kind) return { count: 0, target: rule.target, met: [] };
  const f = rule.filter ?? {};
  const keys = new Set<string>();
  for (const r of rows) {
    if (f.country && r.country !== f.country) continue;
    if (f.region && r.region !== f.region) continue;
    if (f.category && r.category !== f.category) continue;
    for (const k of kind.distinctOf(r)) keys.add(k);
  }
  return { count: Math.min(keys.size, rule.target), target: rule.target, met: [...keys] };
}

