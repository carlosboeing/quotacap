import { describe, it, expect } from "vitest";
import { tools, recommendationTable } from "../../src/mcp/server.js";
describe("mcp", () => {
  it("exposes three tools", () => {
    expect(tools.map(t=>t.name)).toEqual(expect.arrayContaining(["get_quotas","get_recommendation","forecast"]));
  });

  it("renders a markdown table with one row per provider", () => {
    const rec = {
      use: "kimi",
      reason: "78% waste in 3.0d",
      alternatives: [
        { provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00" },
        { provider: "claude", usedPct: 37, resetsAt: "2026-09-03T21:00:00+10:00" },
      ],
      advisories: [
        { provider: "kimi", wastePct: 78.0 },
        { provider: "claude", wastePct: 52.9 },
      ],
    };
    const table = recommendationTable(rec);
    expect(table).toMatch(/\| Provider \| Used \| Remaining \| Resets \| Waste if unused \|/);
    expect(table).toMatch(/\| kimi \| 16% \| 84% \|/);
    expect(table).toMatch(/\| claude \| 37% \| 63% \|/);
    expect(table).toMatch(/\| 78% \|$/m);
  });
});
