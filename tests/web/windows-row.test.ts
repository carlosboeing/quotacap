import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { boardMonthlyStateSnapshotJson, monthlyExhaustedStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel } from "../../web/src/state.js";
import { WindowsRow, windowCountdown, windowUnits } from "../../web/src/components/WindowsRow.js";
import { ProviderCard } from "../../web/src/components/ProviderCard.js";
import { ProviderRow } from "../../web/src/components/ProviderRow.js";

const board = toViewModel(JSON.parse(boardMonthlyStateSnapshotJson));
const byId = (id: string) => board.providers.find((p) => p.id === id)!;
const asOfMs = Date.parse(board.asOf);
const html = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

describe("windowCountdown", () => {
  it("returns one coarse unit", () => {
    expect(windowCountdown(new Date(asOfMs + 7.5 * 86400000).toISOString(), asOfMs)).toBe("7d");
    expect(windowCountdown(new Date(asOfMs + 4.2 * 3600000).toISOString(), asOfMs)).toBe("4h");
    expect(windowCountdown(new Date(asOfMs + 40 * 60000).toISOString(), asOfMs)).toBe("40m");
    expect(windowCountdown(new Date(asOfMs - 1000).toISOString(), asOfMs)).toBeNull();
  });
});

describe("windows row", () => {
  it("OpenCode Go renders one collapsed line with a 5h and a Mth unit", () => {
    const out = html(React.createElement(WindowsRow, { provider: byId("opencode-go"), asOf: board.asOf, variant: "card" }));
    expect(out.match(/class="wline"/g)).toHaveLength(1);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('data-win="five"');
    expect(out).toContain('data-win="month"');
    expect(out).toMatch(/<span class="k">5h<\/span><span class="n">12%<\/span>/);
    expect(out).toMatch(/<span class="k">Mth<\/span><span class="n">95%<\/span>/);
    expect(out).toContain('<span class="seg hot">');
    expect(out).toContain('<span class="t">in 8d</span>');
    expect(out).not.toContain('class="windows"'); // first paint collapsed
    expect(out).not.toContain("Mo<");
  });

  it("the 5h unit carries no time: no 5h reset exists to show", () => {
    const five = windowUnits(byId("opencode-go"), asOfMs).find((u) => u.win === "five")!;
    expect(five.time).toBeNull();
  });

  it("an exhausted month shows the weekday and the full class", () => {
    const s = toViewModel(JSON.parse(monthlyExhaustedStateSnapshotJson));
    const out = html(React.createElement(WindowsRow, { provider: s.providers[0], asOf: s.asOf, variant: "card" }));
    expect(out).toContain('<span class="seg full">');
    expect(out).toContain('<span class="t">Tue</span>');
  });

  it("Claude renders the 5h unit only; Grok renders no line at all", () => {
    const claude = html(React.createElement(WindowsRow, { provider: byId("claude"), asOf: board.asOf, variant: "card" }));
    expect(claude).toContain('data-win="five"');
    expect(claude).not.toContain('data-win="month"');
    expect(html(React.createElement(WindowsRow, { provider: byId("grok"), asOf: board.asOf, variant: "card" }))).toBe("");
  });

  it("mounts between the weekly bar and the stats on the card, and under the bar in the table row", () => {
    const card = html(React.createElement(ProviderCard, { provider: byId("opencode-go"), recommended: false, asOf: board.asOf, onSelect: () => {} }));
    expect(card.indexOf('class="tfoot"')).toBeLessThan(card.indexOf('class="wline"'));
    expect(card.indexOf('class="wline"')).toBeLessThan(card.indexOf('class="pstats"'));
    const row = html(React.createElement(ProviderRow, { provider: byId("claude"), recommended: false, asOf: board.asOf, onSelect: () => {} }));
    expect(row).toContain('class="wline"');
    expect(row).not.toContain("5h Limit ·"); // the old provider-cell line is gone
  });
});
