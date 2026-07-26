import { afterEach, describe, expect, it } from "vitest";
import {
  activeAiProvider,
  aiSupportsServerWebSearch,
  chatModel,
  fastModel,
} from "./client";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("AI provider configuration", () => {
  it("prefers OpenRouter and selects OpenRouter model IDs", () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    expect(activeAiProvider()).toBe("openrouter");
    expect(aiSupportsServerWebSearch()).toBe(false);
    expect(chatModel()).toBe("anthropic/claude-sonnet-4");
    expect(fastModel()).toBe("anthropic/claude-haiku-4.5");
  });

  it("falls back to direct Anthropic when OpenRouter is absent", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    expect(activeAiProvider()).toBe("anthropic");
    expect(aiSupportsServerWebSearch()).toBe(true);
    expect(chatModel()).toBe("claude-sonnet-5");
    expect(fastModel()).toBe("claude-haiku-4-5-20251001");
  });
});
