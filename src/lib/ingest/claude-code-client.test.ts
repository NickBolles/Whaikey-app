import { describe, expect, it } from "vitest";
import { WEDGE_IDS } from "@/lib/flavor-wheel";
import {
  buildClaudeArgs,
  buildProfileArraySchema,
  promptFromMessages,
  structuredOutputText,
} from "./claude-code-client";

describe("Claude Code enrichment client", () => {
  it("builds an exact flavor-profile structured-output schema", () => {
    const schema = buildProfileArraySchema();
    const root = schema as { properties: { profiles: { items: Record<string, unknown> } } };
    const item = root.properties.profiles.items;
    const profile = (item.properties as Record<string, Record<string, unknown>>).profile;
    const profileSchema = profile as { properties: Record<string, unknown>; required: string[] };

    expect(Object.keys(profileSchema.properties)).toEqual(WEDGE_IDS);
    expect(profileSchema.required).toEqual(WEDGE_IDS);
  });

  it("uses the logged-in CLI default unless an operator explicitly overrides it", () => {
    const schema = buildProfileArraySchema();
    const defaultArgs = buildClaudeArgs({ schema });
    expect(defaultArgs).not.toContain("--model");
    expect(defaultArgs).toContain("--no-session-persistence");
    expect(defaultArgs.slice(defaultArgs.indexOf("--tools"), defaultArgs.indexOf("--tools") + 2))
      .toEqual(["--tools", ""]);
    expect(defaultArgs).toContain("--strict-mcp-config");
    expect(defaultArgs).toContain("--disable-slash-commands");

    const webArgs = buildClaudeArgs({ schema, allowWebSearch: true });
    expect(webArgs.slice(webArgs.indexOf("--tools"), webArgs.indexOf("--tools") + 2))
      .toEqual(["--tools", "WebSearch,WebFetch"]);

    const overriddenArgs = buildClaudeArgs({ schema, model: "sonnet" });
    expect(overriddenArgs.slice(-2)).toEqual(["--model", "sonnet"]);
  });

  it("accepts only structured output from a successful Claude CLI result", () => {
    expect(
      structuredOutputText(JSON.stringify({ is_error: false, structured_output: [{ id: "b1", profile: {} }] })),
    ).toBe('[{"id":"b1","profile":{}}]');
    expect(() => structuredOutputText("not-json")).toThrow(/did not return JSON/);
    expect(() => structuredOutputText(JSON.stringify({ is_error: true, result: "rate limited" }))).toThrow(
      /rate limited/,
    );
  });

  it("extracts only user text from a Messages-style payload", () => {
    expect(
      promptFromMessages([
        { role: "assistant", content: "ignore" },
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "user", content: "second" },
      ]),
    ).toBe("first\nsecond");
  });
});
