/**
 * Text-only label fixtures for the on-device OCR matcher (no images in the
 * repo). Each `ocr` string is what Vision / ML Kit plausibly return for the
 * front label — line breaks, shouting caps, small-print boilerplate and the
 * typical confusions ("l2", "GLENFIDDLCH", split words) included on purpose.
 *
 * The seed of the A4 eval set: add real reads from device testing here, and
 * the floor in `label-match.test.ts` keeps the matcher honest.
 */
import type { BottleSearchResult } from "@/lib/search";

const b = (
  id: string,
  name: string,
  distillery: string | null,
  ageYears: number | null,
  abv: number | null,
  category: BottleSearchResult["category"] = "bourbon",
): BottleSearchResult =>
  ({
    id,
    name,
    distillery,
    ageYears,
    abv,
    category,
    country: null,
    region: null,
    avgPrice: null,
    flavorProfile: null,
  }) satisfies BottleSearchResult;

export const FIXTURE_CATALOG: BottleSearchResult[] = [
  b("glenfiddich-12", "Glenfiddich 12 Year Old", "Glenfiddich", 12, 40, "scotch-single-malt"),
  b("glenfiddich-15", "Glenfiddich 15 Year Old Solera", "Glenfiddich", 15, 40, "scotch-single-malt"),
  b("glenfiddich-18", "Glenfiddich 18 Year Old", "Glenfiddich", 18, 40, "scotch-single-malt"),
  b("glenlivet-12", "The Glenlivet 12 Year Old", "The Glenlivet", 12, 40, "scotch-single-malt"),
  b("lagavulin-16", "Lagavulin 16 Year Old", "Lagavulin", 16, 43, "scotch-single-malt"),
  b("lagavulin-8", "Lagavulin 8 Year Old", "Lagavulin", 8, 48, "scotch-single-malt"),
  b("laphroaig-10", "Laphroaig 10 Year Old", "Laphroaig", 10, 40, "scotch-single-malt"),
  b("laphroaig-qc", "Laphroaig Quarter Cask", "Laphroaig", null, 48, "scotch-single-malt"),
  b("macallan-12-sherry", "The Macallan 12 Year Old Sherry Oak", "The Macallan", 12, 43, "scotch-single-malt"),
  b("macallan-12-double", "The Macallan 12 Year Old Double Cask", "The Macallan", 12, 40, "scotch-single-malt"),
  b("buffalo-trace", "Buffalo Trace Kentucky Straight Bourbon", "Buffalo Trace", null, 45),
  b("eagle-rare-10", "Eagle Rare 10 Year", "Buffalo Trace", 10, 45),
  b("wild-turkey-101", "Wild Turkey 101", "Wild Turkey", null, 50.5),
  b("wild-turkey-81", "Wild Turkey 81", "Wild Turkey", null, 40.5),
  b("rare-breed", "Wild Turkey Rare Breed", "Wild Turkey", null, 58.4),
  b("makers-mark", "Maker's Mark", "Maker's Mark", null, 45),
  b("makers-46", "Maker's Mark 46", "Maker's Mark", null, 47),
  b("four-roses-sb", "Four Roses Single Barrel", "Four Roses", null, 50),
  b("four-roses-small", "Four Roses Small Batch", "Four Roses", null, 45),
  b("woodford", "Woodford Reserve Distiller's Select", "Woodford Reserve", null, 45.2),
  b("woodford-double", "Woodford Reserve Double Oaked", "Woodford Reserve", null, 45.2),
  b("redbreast-12", "Redbreast 12 Year Old", "Midleton", 12, 40, "irish"),
  b("redbreast-12-cs", "Redbreast 12 Year Old Cask Strength", "Midleton", 12, 58.6, "irish"),
  b("jameson", "Jameson Irish Whiskey", "Midleton", null, 40, "irish"),
  b("yamazaki-12", "Yamazaki 12 Year", "Suntory (Yamazaki & Hakushu)", 12, 43, "japanese"),
  b("hakushu-12", "Hakushu 12 Year", "Suntory (Yamazaki & Hakushu)", 12, 43, "japanese"),
  b("elijah-craig-sb", "Elijah Craig Small Batch", "Heaven Hill", null, 47),
  b("elijah-craig-bp", "Elijah Craig Barrel Proof", "Heaven Hill", 12, 62),
  b("talisker-10", "Talisker 10 Year Old", "Talisker", 10, 45.8, "scotch-single-malt"),
  b("ardbeg-10", "Ardbeg Ten", "Ardbeg", 10, 46, "scotch-single-malt"),
];

export interface LabelFixture {
  name: string;
  ocr: string;
  expected: string;
  /** Expected to clear the threshold on its own (no AI fallback needed). */
  confident: boolean;
}

export const LABEL_FIXTURES: LabelFixture[] = [
  {
    name: "clean Glenfiddich 12",
    ocr: "Glenfiddich\nSINGLE MALT SCOTCH WHISKY\n12\nYEAR OLD\nOUR SIGNATURE MALT\n40% vol 70cl",
    expected: "glenfiddich-12",
    confident: true,
  },
  {
    name: "OCR-damaged Glenfiddich 18 (l8, misread letter)",
    ocr: "GLENFIDDLCH\nSINGLE MALT\nl8 YEARS OLD\nSMALL BATCH ESKER 4O% VOL",
    expected: "glenfiddich-18",
    confident: true,
  },
  {
    name: "Lagavulin 16 with the age on its own line",
    ocr: "LAGAVULIN\nISLAY SINGLE MALT SCOTCH WHISKY\naged 16 years\nEST. 1816\n43% alc/vol 750ml",
    expected: "lagavulin-16",
    confident: true,
  },
  {
    name: "Laphroaig Quarter Cask (NAS)",
    ocr: "LAPHROAIG\nQUARTER CASK\nISLAY SINGLE MALT SCOTCH WHISKY\n48% vol",
    expected: "laphroaig-qc",
    confident: true,
  },
  {
    name: "Macallan Sherry Oak vs Double Cask",
    ocr: "THE\nMACALLAN\nSHERRY OAK CASK\n12\nYEARS OLD\nHIGHLAND SINGLE MALT SCOTCH WHISKY\n43% vol",
    expected: "macallan-12-sherry",
    confident: true,
  },
  {
    name: "Buffalo Trace with the government warning in view",
    ocr:
      "BUFFALO\nTRACE\nKENTUCKY STRAIGHT BOURBON WHISKEY\n90 PROOF\nGOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC BEVERAGES DURING PREGNANCY",
    expected: "buffalo-trace",
    confident: true,
  },
  {
    name: "Eagle Rare 10",
    ocr: "EAGLE RARE\nKENTUCKY STRAIGHT BOURBON WHISKEY\nAGED 10 YEARS\nSINGLE BARREL\n90 PROOF",
    expected: "eagle-rare-10",
    confident: true,
  },
  {
    name: "Wild Turkey 101 — the number decides",
    ocr: "WILD TURKEY\n101\nKENTUCKY STRAIGHT BOURBON WHISKEY\n101 PROOF\nAUSTIN NICHOLS DISTILLING CO",
    expected: "wild-turkey-101",
    confident: true,
  },
  {
    name: "Wild Turkey Rare Breed",
    ocr: "WILD TURKEY\nRARE BREED\nBARREL PROOF\nKENTUCKY STRAIGHT BOURBON WHISKEY\n116.8 PROOF",
    expected: "rare-breed",
    confident: true,
  },
  {
    name: "Maker's Mark with the apostrophe mangled",
    ocr: "Maker`s\nMark\nKENTUCKY STRAIGHT BOURBON WHISKY\nHANDMADE\n45% Alc./Vol. (90 Proof)",
    expected: "makers-mark",
    confident: true,
  },
  {
    name: "Four Roses Single Barrel",
    ocr: "FOUR\nROSES\nSINGLE BARREL\nKENTUCKY STRAIGHT BOURBON WHISKEY\n100 PROOF  50% ALC/VOL",
    expected: "four-roses-sb",
    confident: true,
  },
  {
    name: "Woodford Double Oaked",
    ocr: "WOODFORD\nRESERVE\nDOUBLE OAKED\nKentucky Straight Bourbon Whiskey\n90.4 proof",
    expected: "woodford-double",
    confident: true,
  },
  {
    name: "Redbreast 12 Cask Strength by ABV",
    ocr: "REDBREAST\nCASK STRENGTH\n12\nYEARS OLD\nSINGLE POT STILL IRISH WHISKEY\n58.6% vol",
    expected: "redbreast-12-cs",
    confident: true,
  },
  {
    name: "Yamazaki 12 — distillery string shared with Hakushu",
    ocr: "THE\nYAMAZAKI\nSINGLE MALT JAPANESE WHISKY\nAGED 12 YEARS\nSUNTORY WHISKY 43%",
    expected: "yamazaki-12",
    confident: true,
  },
  {
    name: "Talisker split across lines",
    ocr: "TALIS\nKER\n10\nYEARS OLD\nISLE OF SKYE SINGLE MALT 45.8%",
    expected: "talisker-10",
    confident: false,
  },
];

/** Reads that must NOT be confident: the AI fallback is the right call. */
export const AMBIGUOUS_READS: Array<{ name: string; ocr: string }> = [
  { name: "only the boilerplate", ocr: "GOVERNMENT WARNING\n750 ML\n40% ALC/VOL" },
  { name: "brand but no expression, many expressions", ocr: "GLENFIDDICH" },
  { name: "garbage", ocr: "xqzt rrrkk 1l1l 0O0" },
  { name: "generic words only", ocr: "KENTUCKY STRAIGHT BOURBON WHISKEY\nSMALL BATCH" },
];
