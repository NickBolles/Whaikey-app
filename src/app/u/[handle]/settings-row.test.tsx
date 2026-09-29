// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OwnSettingsRow } from "./settings-row";

afterEach(cleanup);

describe("OwnSettingsRow (STORYBOARD D13)", () => {
  it("summarises sharing and leads both halves to Settings", () => {
    render(<OwnSettingsRow shareCount={2} defaultVisibility="friends" />);
    const sharing = screen.getByRole("link", { name: /sharing/i });
    expect(sharing).toHaveAttribute("href", "/settings#sharing");
    expect(sharing).toHaveTextContent("2 links · Friends");
    expect(screen.getByRole("link", { name: /^settings/i })).toHaveAttribute("href", "/settings");
  });

  it("uses the singular for one link", () => {
    render(<OwnSettingsRow shareCount={1} defaultVisibility="private" />);
    expect(screen.getByRole("link", { name: /sharing/i })).toHaveTextContent("1 link · Only me");
  });
});
