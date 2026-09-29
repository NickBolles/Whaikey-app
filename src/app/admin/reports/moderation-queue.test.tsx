// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { ModerationQueue } from "./moderation-queue";

afterEach(cleanup);

type ReportOverrides = Partial<Parameters<typeof ModerationQueue>[0]["reports"][number]>;

function queue(overrides: ReportOverrides = {}) {
  return (
    <ModerationQueue
      reports={[
        {
          id: "report_1",
          subjectType: "comment",
          subjectId: "comment_1",
          reason: "abuse",
          createdAt: new Date("2026-09-01T00:00:00Z").toISOString(),
          reporterHandle: "ada",
          reporterDeleted: false,
          ageHours: 1,
          preview: "what it says now",
          reportedPreview: "what was reported",
          liveReadable: true,
          subjectExists: true,
          editedSinceReport: false,
          subjectOwnerId: "user_1",
          subjectOwnerSuspended: false,
          subjectOwnerSuspensionId: null,
          alreadyHidden: false,
          ...overrides,
        },
      ]}
      open={1}
      pageSize={100}
      breached={0}
      slaHours={24}
      audit={[]}
      suspended={[]}
      standingHides={[]}
      newerHidesCursor={null}
      newerSuspendedCursor={null}
    />
  );
}

/**
 * Two claims this row makes about state it cannot actually observe, both of
 * which were false in an ordinary case. The queue is what an operator decides
 * from; a row that misdescribes a complaint is worse than one that says less.
 */
describe("ModerationQueue report rows", () => {
  it("does not call a reporter without a handle a deleted account", () => {
    render(queue({ reporterHandle: null }));

    // A null handle on a live reporter means the account never claimed a
    // social profile, which reporting deliberately allows. Deletion is a
    // separate flag (`reporterDeleted`), not something read off the handle.
    expect(screen.getByText(/reported by/)).toHaveTextContent("an account with no handle");
    expect(screen.queryByText(/deleted/)).toBeNull();
  });

  it("says so when the reporter has since deleted their account", () => {
    // `reports.reporter_id` is `set null` (WP-11): the complaint stays in the
    // queue after its reporter leaves, and the row must not pretend the
    // reporter is a live account without a handle.
    render(queue({ reporterHandle: null, reporterDeleted: true }));
    expect(screen.getByText(/reported by/)).toHaveTextContent(
      "an account that has since been deleted",
    );
  });

  it("names the reporter when there is a handle", () => {
    render(queue());
    expect(screen.getByText(/reported by/)).toHaveTextContent("@ada");
  });

  it("says no copy was kept, not that the subject is gone, on a legacy report", () => {
    // Filed before snapshots, subject still there but now private or
    // withdrawn — so both previews are null and neither is evidence of
    // deletion. STORYBOARD §3.17 is binding on saying which.
    render(
      queue({
        reportedPreview: null,
        preview: null,
        liveReadable: false,
        subjectExists: true,
      }),
    );

    expect(screen.getByText(/No record of what was reported was kept/)).toHaveTextContent(
      "not visible now",
    );
    expect(screen.queryByText(/no longer exists/)).toBeNull();
  });

  it("still says the subject is gone when it actually is", () => {
    render(
      queue({
        reportedPreview: null,
        preview: null,
        liveReadable: false,
        subjectExists: false,
      }),
    );

    expect(screen.getByText("(the reported thing no longer exists)")).toBeInTheDocument();
    expect(screen.getByText(/No record of what was reported was kept/)).toHaveTextContent(
      "no longer exists",
    );
  });

  it("offers the current text on a legacy report, labelled as current", () => {
    render(queue({ reportedPreview: null }));

    expect(
      screen.getByText(/this is the current text, not what was reported/),
    ).toBeInTheDocument();
  });
});
