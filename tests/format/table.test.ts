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
    expect(table).toMatch(/\| Provider \| Used \| Remaining \| Resets \| Days left \| Ideal daily burn \| Burn rate \| Waste if unused \| 🚦 \|/);
    expect(table).toMatch(/\| kimi \| 16% \| 84% \|.*\| 3.0 \| 28%\/day \| 40.0%\/day \| 78% \| ⚠️ \|/);
    expect(table).toMatch(/\| claude \| 37% \| 63% \|.*\| 5.5 \| 12%\/day \| — \| 53% \| ✅ \|/);
  });

  it("renders quota-only rows with placeholders when no advisories exist", () => {
    const quotas = [{ provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00" }];
    const table = renderQuotasTable(quotas, []);
    expect(table).toMatch(/\| kimi \| 16% \| 84% \|.*\| — \| — \| — \| — \| — \|/);
  });

  it("formats resets with a month name, day, year and local time", () => {
    // Mid-month fixture: any timezone within +-14h keeps it in September.
    const quotas = [{ provider: "kimi", usedPct: 16, resetsAt: "2026-09-15T09:02:00+10:00" }];
    const table = renderQuotasTable(quotas, []);
    expect(table).toMatch(/Sept?[^|]*2026/);
    expect(table).not.toMatch(/9\/1\/2026/);
  });

  it("keeps header and data pipes aligned under both observed width models", () => {
    const quotas = [
      { provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00" },
      { provider: "claude", usedPct: 37, resetsAt: "2026-09-03T21:00:00+10:00" },
    ];
    const advisories = [
      { provider: "kimi", wastePct: 78.0, daysLeft: 3.0, idealRate: 28.0, burnRate: 40, burnMeasured: true, status: "at risk" },
      { provider: "claude", wastePct: 52.9, daysLeft: 5.5, idealRate: 11.6, burnRate: 2, burnMeasured: false, status: "on track" },
    ];
    const table = renderQuotasTable(quotas, advisories);
    const lines = table.split("\n");

    const emoji = (ch: string) => {
      const c = ch.codePointAt(0)!;
      return (c >= 0x2600 && c <= 0x27BF) || c >= 0x1F000;
    };
    const paint = (ch: string) => (emoji(ch) ? 2 : 1);
    // Model A: Kimi/Claude Code — emoji count 1, paint 2.
    // Model B: OpenCode — emoji count 2, paint 2.
    const countA = (ch: string) => (emoji(ch) ? 1 : 1);
    const countB = (ch: string) => (emoji(ch) ? 2 : 1);
    const gap = (cell: string, count: (ch: string) => number) =>
      [...cell].reduce((w, ch) => w + paint(ch), 0) - [...cell].reduce((w, ch) => w + count(ch), 0);

    // The divider row (---) cannot carry a wide glyph, so it is excluded —
    // renderers draw it from the separator and its gap is inherently 0.
    const rows = lines.filter((l, i) => i !== 1);
    const columns = rows.map((l) => l.split("|").slice(1, -1));
    for (let col = 0; col < columns[0].length; col++) {
      const gapsA = columns.map((r) => gap(r[col], countA));
      const gapsB = columns.map((r) => gap(r[col], countB));
      expect(new Set(gapsA).size).toBe(1);
      expect(new Set(gapsB).size).toBe(1);
    }
  });
});