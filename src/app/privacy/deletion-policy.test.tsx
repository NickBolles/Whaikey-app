// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ACCOUNT_DATA } from "@/lib/account-data";
import PrivacyPage from "./page";

/**
 * The deletion paragraphs of `/privacy` against `ACCOUNT_DATA` (WP-11).
 *
 * A deletion that removes a row is the default and the page says so in one
 * list. What needs its own sentence is everything that **survives** an
 * account deletion — unlinked or kept — because that is the part a reader
 * would not assume and the part a page is most tempted to leave out. So each
 * such slice names the phrase that discloses it, the phrase is asserted to be
 * on the page, and a new surviving slice fails here until someone writes it.
 */
const SURVIVORS: Record<string, string> = {
  catalog_bottles_you_added: "a bottle you added that is now in the shared catalog",
  submissions_you_reviewed: "if you were ever a moderator, the decisions you made",
  moderation_decisions_you_made: "if you were ever a moderator, the decisions you made",
  reports_filed: "reports you filed about other people’s content",
  reports_about_you: "reports other people filed about something of yours",
  ai_usage: "the AI meter readings and share-link events described above",
  share_events: "the AI meter readings and share-link events described above",
  events_on_your_share_links: "the AI meter readings and share-link events described above",
};

afterEach(cleanup);

function pageText(): string {
  render(<PrivacyPage />);
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

describe("/privacy against the deletion policy", () => {
  it("names every slice that survives an account deletion", () => {
    const surviving = ACCOUNT_DATA.filter((s) => s.onDelete !== "deleted").map((s) => s.key);
    expect(surviving.filter((k) => !(k in SURVIVORS))).toEqual([]);
    expect(Object.keys(SURVIVORS).filter((k) => !surviving.includes(k))).toEqual([]);

    const text = pageText();
    const absent = Object.entries(SURVIVORS).filter(([, phrase]) => !text.includes(phrase));
    expect(absent).toEqual([]);
  });

  it("describes deletion and export as buttons in Settings, not a support request", () => {
    const text = pageText();
    expect(text).toContain("Both are buttons in Settings");
    expect(text).not.toMatch(/not built yet/i);
    expect(text).not.toMatch(/done by hand/i);
    const hrefs = screen.getAllByRole("link", { name: "Settings" }).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/settings");
  });

  it("says what the export leaves out and why", () => {
    const text = pageText();
    expect(text).toContain("a key in it is a way into the account");
    expect(text).toContain("because telling you would undo the block");
  });
});
