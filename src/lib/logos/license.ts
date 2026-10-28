import { sql } from "drizzle-orm";
import type { BrandLogoSource } from "@/db/schema";

/**
 * License gating for brand marks (docs/DATA_SOURCES.md §5.4).
 *
 * - Wikimedia Commons hosts only free files, but we still read each file's
 *   own license and refuse anything we can't name: public domain (incl.
 *   PD-textlogo, the usual verdict for a wordmark), CC0, CC BY, CC BY-SA.
 *   CC BY/BY-SA want a credit, so those marks are shown only where the
 *   credit can sit next to them (the bottle page), never on a small card.
 * - A producer's own site icon is not licensed to us at all; it is shown
 *   under nominative use, to identify the producer of a bottle, unaltered,
 *   and never stretched or recoloured. It needs no credit line but the
 *   bottle page still names where it came from.
 */
export interface LogoLicense {
  license: string;
  attributionRequired: boolean;
}

const PD = /^(public domain|pd\b|pd-|cc0|cc-zero|no restrictions)/i;
const CC_BY = /^cc[ -]by(?:[ -](?:sa))?[ -]?[0-9.]*\b/i;
const NONFREE = /(non[- ]?free|fair use|all rights reserved|\bnc\b|\bnd\b|noncommercial|no derivatives)/i;

/** Commons LicenseShortName → accepted license, or null to refuse the file. */
export function commonsLicense(shortName: string | null | undefined, attributionRequired?: string | boolean | null): LogoLicense | null {
  const name = (shortName ?? "").replace(/<[^>]+>/g, "").trim();
  if (!name || NONFREE.test(name)) return null;
  if (PD.test(name)) return { license: name, attributionRequired: false };
  if (CC_BY.test(name)) return { license: name, attributionRequired: attributionRequired === false || attributionRequired === "false" ? false : true };
  return null;
}

export const NOMINATIVE_USE = "nominative-use";

/** Whether a stored mark may render on a surface. */
export function logoAllowedOn(
  logo: { status: string; logoSource: BrandLogoSource | null; license: string | null; attributionRequired: boolean },
  surface: "card" | "page",
): boolean {
  if (logo.status !== "ok" || !logo.logoSource || !logo.license) return false;
  if (logo.logoSource === "website") return logo.license === NOMINATIVE_USE;
  if (logo.attributionRequired) return surface === "page";
  return true;
}

/**
 * SQL twin of `logoAllowedOn(…, "card")` for list queries: the bottle's brand
 * key when its mark may sit on a card, else null. Correlated on the raw
 * `bottles` table name (Drizzle renders `${table.col}` unqualified).
 */
export const cardLogoKeySql = sql<string | null>`(select bl.key from brand_logos bl where bl.key = bottles.brand_key and bl.status = 'ok' and bl.license is not null and ((bl.logo_source = 'website' and bl.license = 'nominative-use') or (bl.logo_source <> 'website' and bl.attribution_required = false)))`;
