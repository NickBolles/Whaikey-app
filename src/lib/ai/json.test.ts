import { describe, expect, it } from "vitest";
import { parseModelJson, textFromContent } from "./json";

// The model-output parser (review REL-8.4). Every AI feature — extraction,
// pairings, recommendation explanations, label scan — funnels model text
// through parseModelJson, and each one treats `null` as "unusable, degrade
// gracefully". So the contract is two-sided: recover JSON from the shapes
// models actually emit, and return null (never throw) for everything else.

describe("parseModelJson", () => {
  it("parses bare JSON objects, arrays and scalars", () => {
    expect(parseModelJson('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
    expect(parseModelJson("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseModelJson("  42  ")).toBe(42);
    expect(parseModelJson('"just a string"')).toBe("just a string");
  });

  it("strips a ```json fence, with or without the language tag, in any case", () => {
    expect(parseModelJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(parseModelJson('```JSON\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(parseModelJson('```\n[{"x":1}]\n```')).toEqual([{ x: 1 }]);
    expect(parseModelJson('   ```json {"x":1} ```   ')).toEqual({ x: 1 });
  });

  it("recovers the outermost object from surrounding prose", () => {
    const text = 'Sure! Here are the notes:\n{"tags":["vanilla","oak"],"nested":{"k":"v"}}\nHope that helps.';
    expect(parseModelJson(text)).toEqual({ tags: ["vanilla", "oak"], nested: { k: "v" } });
  });

  it("recovers an array from surrounding prose when there is no object", () => {
    expect(parseModelJson("The pairings are [\"dark chocolate\", \"smoked almonds\"] — enjoy.")).toEqual([
      "dark chocolate",
      "smoked almonds",
    ]);
  });

  it("recovers a fenced block that has prose before the fence", () => {
    const text = 'Here you go:\n```json\n{"ok":true}\n```';
    expect(parseModelJson(text)).toEqual({ ok: true });
  });

  it("prefers the whole-object span to an inner array when prose wraps an object containing one", () => {
    const text = 'Result: {"items":[1,2],"n":2} done';
    expect(parseModelJson(text)).toEqual({ items: [1, 2], n: 2 });
  });

  it("falls back to the array span when the brace span is not valid JSON", () => {
    // `{…}` here spans from the stray brace to the one inside the array, which
    // does not parse; the `[…]` span does.
    const text = 'note { see below: [{"a":1}]';
    expect(parseModelJson(text)).toEqual([{ a: 1 }]);
  });

  it("keeps braces and brackets inside strings intact", () => {
    expect(parseModelJson('{"note":"notes of {toffee} and [pepper]"}')).toEqual({
      note: "notes of {toffee} and [pepper]",
    });
  });

  it("preserves unicode", () => {
    expect(parseModelJson('{"name":"Bunnahabhain 12 — Ìle"}')).toEqual({ name: "Bunnahabhain 12 — Ìle" });
  });

  it("returns null, never throws, for anything it cannot recover", () => {
    const junk = [
      "",
      "   ",
      "I'm sorry, I can't help with that.",
      "{not json}",
      '{"truncated": [1, 2',
      "```json\n```",
      "} backwards {",
      "] backwards [",
      "{'single': 'quotes'}",
      '{"trailing": 1,}',
    ];
    for (const text of junk) {
      expect(() => parseModelJson(text)).not.toThrow();
      expect(parseModelJson(text)).toBeNull();
    }
  });

  it("stays linear on a large pathological input", () => {
    const text = "{".repeat(20_000) + "x" + "}".repeat(20_000);
    const start = performance.now();
    expect(parseModelJson(text)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("textFromContent", () => {
  it("joins text blocks with newlines in order", () => {
    expect(
      textFromContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("skips tool_use, thinking and other non-text blocks, and text blocks without a string", () => {
    expect(
      textFromContent([
        { type: "thinking" },
        { type: "tool_use" },
        { type: "text", text: "kept" },
        { type: "text" },
        { type: "server_tool_use", text: "not a text block" },
      ]),
    ).toBe("kept");
  });

  it("returns an empty string for no content", () => {
    expect(textFromContent([])).toBe("");
  });

  it("composes with parseModelJson across split text blocks", () => {
    const text = textFromContent([
      { type: "text", text: "```json" },
      { type: "text", text: '{"ok":true}' },
      { type: "text", text: "```" },
    ]);
    expect(parseModelJson(text)).toEqual({ ok: true });
  });
});
