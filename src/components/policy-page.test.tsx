// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PolicyPage } from "@/components/policy-page";

const KEYS = [
  "NEXT_PUBLIC_LEGAL_ENTITY",
  "NEXT_PUBLIC_LEGAL_JURISDICTION",
  "NEXT_PUBLIC_SUPPORT_EMAIL",
  "NEXT_PUBLIC_POLICY_EFFECTIVE_DATE",
] as const;

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  cleanup();
  setEnv({});
});

const body = <p>Body text.</p>;

/**
 * The banner is the store-readiness check (PLAN.md §9.3), so what it claims
 * has to be true of the environment it is claiming it about — and the page
 * under it has to agree with the banner. Both halves have been wrong once.
 */
describe("PolicyPage legal identity", () => {
  it("names only the facts actually missing", () => {
    setEnv({ NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC" });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("This document is not finished.");
    expect(note).toHaveTextContent(
      "It does not yet name the law it is governed by, an address to reach and the date it takes effect.",
    );
    // Not the company: the page names it three paragraphs down.
    expect(note).not.toHaveTextContent("the company it binds");
  });

  it("counts a missing effective date as unfinished, so the header's note exists", () => {
    setEnv({
      NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC",
      NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA",
      NEXT_PUBLIC_SUPPORT_EMAIL: "support@whaikey.test",
    });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    // The header says "see the note below" without a date, so there has to be
    // a note below to see.
    expect(screen.getByText("Not yet in effect — see the note below.")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("the date it takes effect");
  });

  it("drops the banner and dates the document once all four are set", () => {
    setEnv({
      NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC",
      NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA",
      NEXT_PUBLIC_SUPPORT_EMAIL: "support@whaikey.test",
      NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: "2026-09-04",
    });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("In effect since 2026-09-04.")).toBeInTheDocument();
  });

  it("treats a malformed effective date as not set", () => {
    // A presence check alone published "In effect since 2026-13-40" with no
    // banner under it. The banner is the store-readiness check, so a typo has
    // to read as unfinished rather than as a date the document binds from.
    for (const bad of ["2026-13-40", "2026-02-30", "not a date", "2026-9-4"]) {
      setEnv({
        NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC",
        NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA",
        NEXT_PUBLIC_SUPPORT_EMAIL: "support@whaikey.test",
        NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: bad,
      });
      render(<PolicyPage title="Terms">{body}</PolicyPage>);

      expect(screen.getByRole("note")).toHaveTextContent("the date it takes effect");
      expect(screen.getByText("Not yet in effect — see the note below.")).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(`In effect since ${bad}`))).toBeNull();
      cleanup();
    }
  });

  it("treats a malformed support email as not set", () => {
    // A presence check published an unusable `mailto:` on both policy pages
    // and /support — on the one fact a reader needs when something has gone
    // wrong — while the banner said the page was finished.
    for (const bad of ["support.example.com", "support@", "@whaikey.test", "not an address"]) {
      setEnv({
        NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC",
        NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA",
        NEXT_PUBLIC_SUPPORT_EMAIL: bad,
        NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: "2026-09-04",
      });
      render(<PolicyPage title="Terms">{body}</PolicyPage>);

      expect(screen.getByRole("note")).toHaveTextContent("an address to reach");
      expect(document.querySelector(`a[href="mailto:${bad}"]`)).toBeNull();
      cleanup();
    }
  });

  it("publishes a well-formed support email", () => {
    setEnv({
      NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC",
      NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA",
      NEXT_PUBLIC_SUPPORT_EMAIL: "support@whaikey.test",
      NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: "2026-09-04",
    });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    expect(screen.queryByRole("note")).toBeNull();
    expect(document.querySelector('a[href="mailto:support@whaikey.test"]')).not.toBeNull();
  });

  /**
   * Each identity fact stands on its own. The company used to gate both, so a
   * configured jurisdiction was thrown away and called unpublished while the
   * banner above correctly named only the company as absent — the page
   * contradicting its own notice about the state it is in.
   */
  it("renders a configured jurisdiction even with no entity", () => {
    setEnv({ NEXT_PUBLIC_LEGAL_JURISDICTION: "the State of Delaware, USA" });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    const who = screen.getByRole("heading", { name: "Who this is" }).parentElement!;
    expect(who).toHaveTextContent("governed by the laws of the State of Delaware, USA");
    expect(who).toHaveTextContent("The operating company is not yet published here.");
    expect(who).not.toHaveTextContent("governing law are not yet published");
  });

  it("renders a configured entity even with no jurisdiction", () => {
    setEnv({ NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey, LLC" });
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    const who = screen.getByRole("heading", { name: "Who this is" }).parentElement!;
    expect(who).toHaveTextContent("Whaikey is operated by Whaikey, LLC.");
    expect(who).toHaveTextContent("The governing law is not yet published here.");
  });

  it("says both are unpublished only when both are", () => {
    setEnv({});
    render(<PolicyPage title="Terms">{body}</PolicyPage>);

    const who = screen.getByRole("heading", { name: "Who this is" }).parentElement!;
    expect(who).toHaveTextContent("The operating company and governing law are not yet published here.");
  });
});

describe("the in-effect label against the unfinished banner", () => {
  it("does not declare itself in effect while a required fact is missing", () => {
    setEnv({
      NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey Ltd",
      NEXT_PUBLIC_LEGAL_JURISDICTION: "New Zealand",
      NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: "2026-09-01",
      // No support address.
    });
    render(<PolicyPage title="Privacy">{body}</PolicyPage>);
    // The header keyed on the date alone, so this page said "In effect since
    // 2026-09-01." directly above a banner saying it is unfinished and must
    // not be treated as an agreement — one screen contradicting itself,
    // decided by which env vars happened to be set first.
    expect(screen.queryByText(/In effect since/)).not.toBeInTheDocument();
    expect(screen.getByText(/Not yet in effect/)).toBeInTheDocument();
    expect(screen.getByText(/This document is not finished/)).toBeInTheDocument();
  });

  it("declares itself in effect only once every fact is set", () => {
    setEnv({
      NEXT_PUBLIC_LEGAL_ENTITY: "Whaikey Ltd",
      NEXT_PUBLIC_LEGAL_JURISDICTION: "New Zealand",
      NEXT_PUBLIC_SUPPORT_EMAIL: "hello@example.com",
      NEXT_PUBLIC_POLICY_EFFECTIVE_DATE: "2026-09-01",
    });
    render(<PolicyPage title="Privacy">{body}</PolicyPage>);
    expect(screen.getByText(/In effect since 2026-09-01/)).toBeInTheDocument();
    expect(screen.queryByText(/This document is not finished/)).not.toBeInTheDocument();
  });
});
