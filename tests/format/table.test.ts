import { describe, it, expect } from "vitest";
import { renderQuotasTable } from "../../src/format/table.js";

describe("format table", () => {
  it("renders a markdown table with one row per provider", () => {
    const quotas = [
      { provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00" },
      { provider: "claude", usedPct: 37, resetsAt: "2026-09-03T21:00:00+10:00" },
    ];
    const advisories = [
      { provider: "kimi", wastePct: 78.0, daysLeft: 3.0, idealRate: 28.0, burnRate: 40, burnMeasured: true, status: "at risk" },
      { provider: "claude", wastePct: 52.9, daysLeft: 5.5, idealRate: 11.6, burnRate: 2, burnMeasured: false, status: "on track" },
    ];
    const table = renderQuotasTable(quotas, advisories);
    expect(table).toMatch(/\| Provider \| Used \| Remaining \| Resets \| Days left \| Ideal daily burn \| Burn rate \| Status \| Waste if unused \|/);
    expect(table).toMatch(/\| kimi \| 16% \| 84% \|.*\| 3.0 \| 28%\/day \| 40.0%\/day \| ⚠️ \| 78% \|/);
    expect(table).toMatch(/\| claude \| 37% \| 63% \|.*\| 5.5 \| 12%\/day \| collecting… \| ✅ \| 53% \|/);
  });

  it("renders quota-only rows with placeholders when no advisories exist", () => {
    const quotas = [{ provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00" }];
    const table = renderQuotasTable(quotas, []);
    expect(table).toMatch(/\| kimi \| 16% \| 84% \|.*\| — \| — \| — \| — \| — \|/);
  });
});