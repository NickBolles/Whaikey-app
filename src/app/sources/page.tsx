import type { Metadata } from "next";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Sources and credits",
  description: `Where ${BRAND_NAME}'s catalog comes from, and the licences it is used under.`,
};

/**
 * `/sources` — credits and licences for third-party data (DRAFT — owner +
 * legal review; docs/DATA_SOURCES.md is the engineering record behind it).
 *
 * Two jobs. It satisfies the attribution conditions of the open licences we
 * use (CC BY 4.0, the Open Government Licence – British Columbia, ODbL produced-
 * work notices), and it is the carve-out the Terms point at: the Terms forbid
 * bulk-copying Caskfolk, but they cannot take away anybody's right to the open
 * data underneath — so this page says where to get it from the source instead.
 *
 * Every row must match a source that actually feeds the app. Adding an ingest
 * adapter means adding its row here in the same PR; a credit for a source we
 * stopped using stays while bottles it imported remain in the catalog.
 */
type Source = {
  name: string;
  href: string;
  what: string;
  licence: string;
  licenceHref?: string;
  /** The attribution line the licence asks for, verbatim where it prescribes one. */
  notice?: string;
};

const CATALOG: Source[] = [
  {
    name: "TTB Public COLA Registry (US Alcohol and Tobacco Tax and Trade Bureau)",
    href: "https://ttbonline.gov/colasonline/publicSearchColasBasic.do",
    what: "Names and categories of US-approved whisky labels.",
    licence: "US government public record (no copyright in the records). Label artwork belongs to the brand owner and is not shown.",
  },
  {
    name: "Iowa Alcoholic Beverages Division — Liquor Products (Iowa Data Hub)",
    href: "https://data.iowa.gov",
    what: "Product names, proof, list prices and barcodes for mainstream US bottles.",
    licence: "CC BY 4.0",
    licenceHref: "https://creativecommons.org/licenses/by/4.0/",
    notice: "Contains data from the State of Iowa, licensed under CC BY 4.0. Names were normalised and matched to our catalog.",
  },
  {
    name: "BC Liquor Distribution Branch — product price list (BC Data Catalogue)",
    href: "https://catalogue.data.gov.bc.ca",
    what: "Product names, categories, ABV and barcodes.",
    licence: "Open Government Licence – British Columbia",
    licenceHref: "https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc",
    notice: "Contains information licensed under the Open Government Licence – British Columbia.",
  },
  {
    name: "Oregon Liquor and Cannabis Commission — product price list",
    href: "https://www.oregon.gov/olcc",
    what: "Product names, categories, age, ABV and shelf prices.",
    licence: "Published state record — terms to be confirmed (see the open questions in the draft).",
  },
  {
    name: "Utah Department of Alcoholic Beverage Services — product list",
    href: "https://abs.utah.gov",
    what: "Product names, categories and prices.",
    licence: "Published state record — terms to be confirmed.",
  },
  {
    name: "Systembolaget product data (via the community mirror C4illin/systembolaget-data)",
    href: "https://github.com/C4illin/systembolaget-data",
    what: "Names, categories and ABV of whiskies sold in Sweden.",
    licence: "Terms to be confirmed.",
  },
  {
    name: "Vinmonopolet developer API",
    href: "https://api.vinmonopolet.no",
    what: "Product names of whiskies sold in Norway.",
    licence: "Vinmonopolet API terms of use.",
  },
  {
    name: "WHISKY:EDITION (no longer used; bottles imported from it remain)",
    href: "https://creativecommons.org/licenses/by/4.0/",
    what: "Factual bottle metadata.",
    licence: "CC BY 4.0",
    licenceHref: "https://creativecommons.org/licenses/by/4.0/",
    notice: "Contains data from WHISKY:EDITION, licensed under CC BY 4.0.",
  },
];

const LOOKUPS: Source[] = [
  {
    name: "Open Food Facts",
    href: "https://world.openfoodfacts.org",
    what: "Looked up, barcode by barcode, when we do not recognise a scan. Kept in a separate cache, used only to search our own catalog, and never merged into it.",
    licence: "Open Database Licence (ODbL) 1.0",
    licenceHref: "https://opendatacommons.org/licenses/odbl/1-0/",
    notice: "Barcode lookups use information from Open Food Facts, made available under the Open Database Licence (ODbL).",
  },
  {
    name: "UPCitemdb",
    href: "https://www.upcitemdb.com",
    what: "Barcode lookups, under its API terms; answers are cached for a limited time and not redistributed.",
    licence: "UPCitemdb API terms of service.",
  },
];

export default function SourcesPage() {
  return (
    <div className="px-4 py-8 max-w-2xl mx-auto w-full flex flex-col gap-6 text-sm text-muted">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Sources and credits</h1>
        <p>
          {BRAND_NAME}&apos;s catalog is built from public records, open data, a few licensed lookups, and
          what people who use it add. This page credits the parts that came from somebody else, under
          the licences they were given to us on.
        </p>
      </header>

      <Block title="What is ours, and what is not">
        <p>
          The way the catalog is put together — which bottles, how they are matched and grouped, the
          flavour profiles, the barcode confirmations, the editing — is {BRAND_NAME}&apos;s own work,
          and the{" "}
          <Link href="/terms" className="text-accent">
            Terms
          </Link>{" "}
          ask you not to copy it in bulk. The open data listed below is not ours to restrict: if you
          want it, take it from the source, under that source&apos;s licence. Nothing in our Terms
          limits what an open licence lets you do with the original.
        </p>
        <p>
          Your own notes, ratings and photos stay yours; see the Terms for what you let us do with
          them.
        </p>
      </Block>

      <Block title="Catalog data">
        <SourceList sources={CATALOG} />
      </Block>

      <Block title="Barcode lookups">
        <SourceList sources={LOOKUPS} />
      </Block>

      <Block title="Flavour profiles and tasting notes">
        <p>
          Community flavour profiles are built only from tasting notes their owners chose to publish,
          and only once at least three people are behind them. Where no community profile exists, a
          profile may be estimated by an AI model; those are labelled as estimates, and any summary of
          published tasting notes links the pages it was drawn from. Reviews from editorial sites are
          linked, never copied.
        </p>
      </Block>

      <Block title="Images and logos">
        <p>
          Bottles without a licensed photo are drawn by {BRAND_NAME}. A licensed bottle photo, where
          one is shown, is credited next to the image.
        </p>
        <p>
          Producer logos come from{" "}
          <a
            href="https://commons.wikimedia.org/"
            className="text-accent"
            rel="noopener noreferrer"
            target="_blank"
          >
            Wikimedia Commons
          </a>
          , each used under that file&apos;s own licence. Public-domain and CC0 marks may appear
          anywhere in the app. Marks under{" "}
          <a
            href="https://creativecommons.org/licenses/by-sa/4.0/"
            className="text-accent"
            rel="noopener noreferrer license"
            target="_blank"
          >
            CC BY or CC BY-SA
          </a>{" "}
          appear only on a bottle&apos;s page, with the file&apos;s author and licence credited
          next to the logo. Where Commons has no usable file, we may show the producer&apos;s own
          site icon, unaltered, only to identify who makes the bottle; its bottle page says where
          it came from.
        </p>
        <p>
          Logos and trademarks belong to their owners. Showing them identifies a producer and
          doesn&apos;t mean that producer endorses {BRAND_NAME}.
        </p>
      </Block>

      <Block title="Something here is yours?">
        <p>
          If you hold rights in something shown in {BRAND_NAME} and want it credited differently or
          removed, tell us through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>
          .
        </p>
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {sources.map((s) => (
        <li key={s.name} className="flex flex-col gap-0.5">
          <a href={s.href} className="text-accent" rel="noopener noreferrer" target="_blank">
            {s.name}
          </a>
          <span>{s.what}</span>
          <span>
            Licence:{" "}
            {s.licenceHref ? (
              <a href={s.licenceHref} className="text-accent" rel="noopener noreferrer license" target="_blank">
                {s.licence}
              </a>
            ) : (
              s.licence
            )}
          </span>
          {s.notice && <span className="italic">{s.notice}</span>}
        </li>
      ))}
    </ul>
  );
}
