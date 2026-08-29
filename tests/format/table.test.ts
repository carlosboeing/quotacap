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
    expect(table).toMatch(/\| Provider \| Used \| Remaining \| Resets \| Days left \| Ideal daily burn \| Burn rate \| Waste if unused \| Status \|/);
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

  it("shows the labeled period average when burn is unmeasured", () => {
    const now = Date.now();
    const quotas = [
      { provider: "kimi", usedPct: 16, resetsAt: "2026-09-01T09:02:00+10:00", periodStart: new Date(now - 4 * 86400000).toISOString() },
    ];
    const advisories = [
      { provider: "kimi", wastePct: 78.0, daysLeft: 2.9, idealRate: 29.0, burnRate: 2, burnMeasured: false, status: "on track" },
    ];
    const table = renderQuotasTable(quotas, advisories);
    expect(table).toMatch(/4.0%\/day avg/);
  });

  it("prefers the measured burn over the period average", () => {
    const now = Date.now();
    const quotas = [
      { provider: "claude", usedPct: 45, resetsAt: "2026-09-03T21:00:00+10:00", periodStart: new Date(now - 2 * 86400000).toISOString() },
    ];
    const advisories = [
      { provider: "claude", wastePct: 0, daysLeft: 5.4, idealRate: 10.0, burnRate: 25.3, burnMeasured: true, status: "at risk" },
    ];
    const table = renderQuotasTable(quotas, advisories);
    expect(table).toMatch(/\| 25.3%\/day \|/);
    expect(table).not.toMatch(/avg/);
  });

  it("keeps every internal pipe aligned — no wide glyphs outside the Status column", () => {
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

    // Renderers that count emoji as one cell but paint two shift every pipe
    // after the glyph. The status glyphs are confined to the last column, so
    // the shift can only ever touch the right border, never an internal pipe.
    for (const line of lines) {
      const cells = line.split("|").slice(1, -1);
      for (const cell of cells.slice(0, -1)) {
        expect([...cell].some(emoji)).toBe(false);
      }
    }
  });
});