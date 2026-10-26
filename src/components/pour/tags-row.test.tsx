// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TagsRow } from "./tags-row";

function Harness({ initial = [] as string[], spy }: { initial?: string[]; spy?: (t: string[]) => void }) {
  const [tags, setTags] = useState(initial);
  return (
    <TagsRow
      value={tags}
      onChange={(next) => {
        spy?.(next);
        setTags(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TagsRow", () => {
  it("offers the user's own tags, adds on tap, removes on tap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ tags: [{ name: "blind" }, { name: "gift" }] }) }) as Response));
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add tag blind" }));
    expect(spy).toHaveBeenLastCalledWith(["blind"]);
    // A chosen suggestion leaves the suggestion list.
    expect(screen.queryByRole("button", { name: "Add tag blind" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove tag blind" }));
    expect(spy).toHaveBeenLastCalledWith([]);
  });

  it("types new tags (comma or Enter), ignoring duplicates by case", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response));
    const spy = vi.fn();
    render(<Harness initial={["Gift"]} spy={spy} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Tag/ }));
    const input = screen.getByLabelText("New tag");
    fireEvent.change(input, { target: { value: "#tasting night, gift" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(["Gift", "tasting night"]);
  });
});
