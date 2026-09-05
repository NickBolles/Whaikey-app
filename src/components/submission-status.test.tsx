// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SubmissionStatus } from "./submission-status";

afterEach(cleanup);

describe("SubmissionStatus", () => {
  it("says nothing once the bottle is in the catalog", () => {
    const { container } = render(
      <SubmissionStatus state="approved" reviewNote="fine" duplicateOfBottleId={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("tells a waiting submitter what waiting means", () => {
    render(<SubmissionStatus state="pending" reviewNote={null} duplicateOfBottleId={null} />);
    expect(screen.getByText(/yours to use right now/i)).toBeTruthy();
    expect(screen.getByText(/doesn't count toward passport stamps/i)).toBeTruthy();
  });

  it("shows the reason a decline was given, and says the bottle is still theirs", () => {
    render(
      <SubmissionStatus
        state="rejected"
        reviewNote="This is a bar's house pour, not a bottling."
        duplicateOfBottleId={null}
      />,
    );
    expect(screen.getByText(/didn't make it into the shared catalog/i)).toBeTruthy();
    expect(screen.getByText(/stays on your shelf/i)).toBeTruthy();
    expect(screen.getByText(/house pour, not a bottling/i)).toBeTruthy();
  });

  it("points a duplicate at the bottle we already had", () => {
    render(
      <SubmissionStatus state="duplicate" reviewNote={null} duplicateOfBottleId="bottle-42" />,
    );
    expect(screen.getByRole("link", { name: /see the one we have/i }).getAttribute("href")).toBe(
      "/bottles/bottle-42",
    );
  });
});
