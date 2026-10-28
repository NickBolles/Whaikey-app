import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  const rules = robots().rules;
  const list = Array.isArray(rules) ? rules : [rules];
  const agents = (r: (typeof list)[number]) => (Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent]);

  it("shuts AI-training crawlers out of the whole site", () => {
    const ai = list.find((r) => agents(r).includes("GPTBot"));
    expect(ai?.disallow).toBe("/");
    for (const bot of ["ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended", "meta-externalagent"]) {
      expect(agents(ai!)).toContain(bot);
    }
  });

  it("does not block ordinary search engines from the public pages", () => {
    for (const r of list) {
      for (const bot of ["Googlebot", "Bingbot", "Applebot", "DuckDuckBot"]) expect(agents(r)).not.toContain(bot);
    }
    const star = list.find((r) => agents(r).includes("*"));
    expect(star?.allow).toBe("/");
  });

  it("keeps every crawler off the API, the admin tools and people's shared things", () => {
    const star = list.find((r) => agents(r).includes("*"));
    expect(star?.disallow).toEqual(expect.arrayContaining(["/api/", "/admin/", "/s/", "/u/"]));
  });
});
