import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boardMonthlyStateSnapshotJson } from "../fixtures/stable-state.js";
import { toViewModel, type ProviderView } from "../../web/src/state.js";
import { limitStamp } from "../../src/format/rate-limit-wait.js";
import { RateLimitNote } from "../../web/src/components/RateLimitNote.js";
import { ProviderCard } from "../../web/src/components/ProviderCard.js";
import { ProviderRow } from "../../web/src/components/ProviderRow.js";

const board = toViewModel(JSON.parse(boardMonthlyStateSnapshotJson));
const asOfMs = Date.parse(board.asOf);
const html = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

function withFiveHour(id: string, pct: number, resetsAt: string | undefined): ProviderView {
  const provider = board.providers.find((p) => p.id === id)!;
  return {
    ...provider,
    quota: provider.quota
      ? { ...provider.quota, fiveHourPct: pct, sessionPct: pct, fiveHourResetsAt: resetsAt }
      : null,
  };
}

describe("rate limit note", () => {
  it("prints the finish date and time on the card and the table row when the 5h limit is full", () => {
    const resetsAt = new Date(asOfMs + 2 * 3_600_000).toISOString();
    const claude = withFiveHour("claude", 100, resetsAt);
    const sentence = `5h limit until ${limitStamp(resetsAt)}`;
    const card = html(React.createElement(ProviderCard, { provider: claude, recommended: false, asOf: board.asOf, onSelect: () => {} }));
    const row = html(React.createElement(ProviderRow, { provider: claude, recommended: false, asOf: board.asOf, onSelect: () => {} }));
    const open = html(React.createElement(ProviderCard, {
      provider: withFiveHour("claude", 25, resetsAt),
      recommended: false,
      asOf: board.asOf,
      onSelect: () => {},
    }));
    const badge = (out: string) => out.match(/data-testid="pace-badge"[^>]*>([^<]*)</)?.[1]?.trim() ?? "";
    expect(card).toContain(sentence);
    expect(card).toContain('data-testid="rate-wait-claude"');
    expect(row).toContain(sentence);
    expect(badge(card)).toBe(badge(open));
    expect(badge(card)).not.toBe("");
  });

  it("omits the note when the 5h window still has room", () => {
    const claude = withFiveHour("claude", 25, new Date(asOfMs + 3_600_000).toISOString());
    const out = html(React.createElement(RateLimitNote, { provider: claude, asOf: board.asOf }));
    expect(out).toBe("");
  });
});
