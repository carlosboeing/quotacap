import { describe, it, expect } from "vitest";
import {
  exampleStateSnapshotJson,
  staleStateSnapshotJson,
  resetPassedStateSnapshotJson,
  unknownPaceStateSnapshotJson,
  monthlyStateSnapshotJson,
  monthlyExhaustedStateSnapshotJson,
} from "../fixtures/stable-state.js";
import React from "react";
import { renderToString } from "react-dom/server";
import { toViewModel } from "../../web/src/state.js";
import { Badge, PaceBar, forecastLine, hatchGradient, paceBadge, paceCells, paceFigures, paceLines, resetClock, resetDateClock, resetDay } from "../../web/src/components/PaceBar.js";
import { ProviderCard } from "../../web/src/components/ProviderCard.js";
import { ProviderRow } from "../../web/src/components/ProviderRow.js";
import { sortProviders } from "../../web/src/components/SubscriptionList.js";

describe("pace badges", () => {
  it("maps every fixture provider without client thresholds", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    expect(paceBadge(s.providers.find((p: any) => p.id === "grok"))).toBe("Not reporting");
    for (const p of JSON.parse(staleStateSnapshotJson).providers) {
      if (p.exclusionReason) expect(paceBadge(p)).toBe("Not reporting");
    }
    for (const p of JSON.parse(resetPassedStateSnapshotJson).providers) {
      if (p.exclusionReason === "reset-passed") expect(paceBadge(p)).toBe("Not reporting");
    }
  });
  it("covers the full badge table over fixtures and synthetic states", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byId = new Map<string, any>(s.providers.map((p: any) => [p.id, p]));
    expect(paceBadge(byId.get("claude"))).toBe("Behind pace"); // urgency save
    expect(paceBadge(byId.get("kimi"))).toBe("Behind pace");
    expect(paceBadge(byId.get("agy"))).toBe("Measuring"); // unknown pace reads Measuring, not On track
    expect(paceBadge(byId.get("manual"))).toBe("Not reporting");
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    expect(paceBadge(u.providers.find((p: any) => p.id === "kimi"))).toBe("Measuring");
    // No fixture carries at-risk or slow-down advisories; map them synthetically.
    expect(paceBadge({ exclusionReason: null, advisory: { status: "unknown", urgency: "on track" } } as any)).toBe(
      "Measuring"
    );
    expect(paceBadge({ exclusionReason: null, advisory: { status: "at risk", urgency: "on track" } } as any)).toBe(
      "Cap risk"
    );
    expect(paceBadge({ exclusionReason: null, advisory: { status: "on track", urgency: "slow down" } } as any)).toBe(
      "Ahead of pace"
    );
  });
  it("maps the watch tier and revives Ahead of pace from cumulative position", () => {
    for (const urgency of ["burn now", "slow down", "save", "on track"]) {
      expect(paceBadge({ exclusionReason: null, advisory: { status: "watch", urgency } } as any)).toBe("Watch");
    }
    expect(
      paceBadge({ exclusionReason: null, advisory: { status: "at risk", urgency: "on track" } } as any),
    ).toBe("Cap risk");
    expect(
      paceBadge({
        exclusionReason: null,
        advisory: { status: "on track", urgency: "save", aheadOfElapsed: true },
      } as any),
    ).toBe("Ahead of pace");
    expect(
      paceBadge({
        exclusionReason: null,
        advisory: { status: "on track", urgency: "save", aheadOfElapsed: false },
      } as any),
    ).toBe("Behind pace");
    expect(
      paceBadge({
        exclusionReason: null,
        advisory: { status: "on track", urgency: "on track", aheadOfElapsed: true },
      } as any),
    ).toBe("Ahead of pace");
  });
});

describe("pace figures", () => {
  it("splits the advisory into window average and 24h rate", () => {
    expect(paceFigures({ avgPace: 10.6, burnRate: 0, paceSource: "recent" })).toEqual({ avg: 10.6, recent: 0 });
    expect(paceFigures({ avgPace: 3.1, burnRate: 3.1, paceSource: "window-average" })).toEqual({ avg: 3.1, recent: null });
    expect(paceFigures({ avgPace: null, burnRate: null, paceSource: "unknown" })).toEqual({ avg: null, recent: null });
    expect(paceFigures(null)).toEqual({ avg: null, recent: null });
  });
  it("renders average and 24h as peer card cells, dash when unknown", () => {
    expect(paceCells({ avgPace: 10.6, burnRate: 0, paceSource: "recent" })).toEqual({
      avg: "10.6%/day",
      recent: "0.0%/day",
    });
    expect(paceCells({ avgPace: 3.1, burnRate: 3.1, paceSource: "window-average" })).toEqual({
      avg: "3.1%/day",
      recent: "—",
    });
    expect(paceCells({ avgPace: null, burnRate: 17, paceSource: "recent" })).toEqual({
      avg: "—",
      recent: "17.0%/day",
    });
    expect(paceCells(null)).toEqual({ avg: "—", recent: "—" });
  });
  it("reads the measured recent rate for the 24h cell, never the blended forecast", () => {
    expect(
      paceFigures({ avgPace: 10.6, burnRate: 7.2, recentRate: 0, paceSource: "recent" }),
    ).toEqual({ avg: 10.6, recent: 0 });
    expect(
      paceCells({ avgPace: 10.6, burnRate: 7.2, recentRate: 0, paceSource: "recent" }),
    ).toEqual({ avg: "10.6%/day", recent: "0.0%/day" });
    expect(
      paceCells({ avgPace: 3.1, burnRate: 12, recentRate: null, paceSource: "window-average" }),
    ).toEqual({ avg: "3.1%/day", recent: "—" });
    // A daemon older than the blend omits recentRate; burnRate was the raw 24h then.
    expect(paceCells({ avgPace: 10.6, burnRate: 0, paceSource: "recent" })).toEqual({
      avg: "10.6%/day",
      recent: "0.0%/day",
    });
  });
  it("stacks labeled pace lines plus ideal for table rows", () => {
    expect(paceLines({ avgPace: 10.6, burnRate: 0, paceSource: "recent", idealRate: 24.1 })).toEqual([
      { label: "Avg", value: "10.6%/day", tip: expect.stringContaining("Window average") },
      { label: "24h", value: "0.0%/day", tip: expect.stringContaining("last 24 hours") },
      { label: "Ideal", value: "24.1%/day", tip: expect.stringContaining("exactly on 100%") },
    ]);
    expect(
      paceLines({ avgPace: 10.6, burnRate: 7.2, recentRate: 0, paceSource: "recent", idealRate: 24.1 }),
    ).toEqual([
      { label: "Avg", value: "10.6%/day", tip: expect.stringContaining("Window average") },
      { label: "24h", value: "0.0%/day", tip: expect.stringContaining("last 24 hours") },
      { label: "Ideal", value: "24.1%/day", tip: expect.stringContaining("exactly on 100%") },
    ]);
    expect(paceLines({ avgPace: 3.1, burnRate: 3.1, paceSource: "window-average", idealRate: 5 })).toEqual([
      { label: "Avg", value: "3.1%/day", tip: expect.stringContaining("Window average") },
      { label: "Ideal", value: "5.0%/day", tip: expect.stringContaining("exactly on 100%") },
    ]);
    expect(paceLines(null)).toEqual([]);
  });
  it("exposes hover explanations on card and row pace labels", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    kimi.advisory = { ...kimi.advisory!, burnRate: 0, recentRate: 0, avgPace: 10.6, paceSource: "recent" };
    const card = renderToString(
      React.createElement(ProviderCard, { provider: kimi, recommended: true, asOf: s.asOf, onSelect: () => {} }),
    );
    for (const tip of ["Window average", "last 24 hours", "exactly on 100%"]) {
      expect(card).toContain(`title="`);
      expect(card).toContain(tip);
    }
    const row = renderToString(
      React.createElement(ProviderRow, { provider: kimi, recommended: true, asOf: s.asOf, onSelect: () => {} }),
    );
    for (const tip of ["Window average", "last 24 hours", "exactly on 100%"]) {
      expect(row).toContain(tip);
    }
  });
  it("names exhausted windows in the forecast line", () => {
    const capped = {
      exclusionReason: null,
      quota: { weeklyPct: 100 },
      advisory: {
        remaining: 0,
        paceSource: "recent",
        burnRate: 0,
        status: "at risk",
        urgency: "slow down",
        daysToExhaust: 0,
        wastePct: 0,
        daysLeft: 0.9,
      },
    };
    expect(forecastLine(capped as any)).toBe("Exhausted · quota fully used");
  });
  it("renders watch with the finite exhaustion clock and without one otherwise", () => {
    const watch = (over: any = {}) => ({
      exclusionReason: null,
      quota: { weeklyPct: 88 },
      advisory: {
        remaining: 12,
        paceSource: "recent",
        burnRate: 6,
        recentRate: 6,
        baselineRate: 3,
        aheadOfElapsed: false,
        status: "watch",
        urgency: "save",
        daysToExhaust: 2.1,
        wastePct: 0,
        daysLeft: 7,
        ...over,
      },
    });
    expect(forecastLine(watch() as any)).toBe("Watch · exhausts in 2.1d at current pace");
    expect(forecastLine(watch({ daysToExhaust: Infinity }) as any)).toBe("Watch at current pace");
    expect(forecastLine(watch({ daysToExhaust: null }) as any)).toBe("Watch at current pace");
  });
  it("explains red and amber badges, confessing the estimated reset", () => {
    const rendered = (advisory: any, quota: any = { weeklyPct: 90 }) =>
      renderToString(
        React.createElement(Badge, { provider: { exclusionReason: null, quota, advisory } as any }),
      );
    const red = "Burning faster than the window allows and ahead of elapsed time";
    const amber = "Pace points at the cap, but position or the reset clock is uncertain";
    expect(rendered({ status: "at risk", urgency: "burn now" })).toContain(`title="${red}"`);
    expect(rendered({ status: "at risk", urgency: "burn now" }, { weeklyPct: 90, resetsAtEstimated: true })).toContain(
      `title="${red} (estimated reset)"`,
    );
    expect(rendered({ status: "watch", urgency: "save" })).toContain(`title="${amber}"`);
    expect(rendered({ status: "watch", urgency: "save" }, { weeklyPct: 90, resetsAtEstimated: true })).toContain(
      `title="${amber} (estimated reset)"`,
    );
    expect(rendered({ status: "on track", urgency: "on track" })).not.toContain("title=");
  });
});

describe("reset clock", () => {
  it("formats weekday and 24h time with a space, not a middot", () => {
    expect(resetClock("2026-09-10T21:00:00+10:00", "en-US")).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/);
    expect(resetClock("2026-09-10T21:00:00+10:00", "en-US")).not.toContain("·");
    expect(resetClock("not-a-date", "en-US")).toBeNull();
  });

  it("resetDateClock adds the calendar date a monthly reset needs", () => {
    // Shape, not the clock reading: the time renders in the machine zone.
    expect(resetDateClock("2026-09-10T21:00:00+10:00", "en-US")).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
    expect(resetDateClock("not-a-date", "en-US")).toBeNull();
  });

  it("resetDay pins weekday plus date in English", () => {
    expect(resetDay("2026-09-15T12:00:00.000Z")).toBe("Tue Sep 15");
  });
});

describe("projected-unused hatch", () => {
  it("paints an ink mix gradient, never an alpha suffix on a custom property", () => {
    const gradient = hatchGradient("Behind pace");
    expect(gradient).not.toMatch(/var\(--[a-z-]+\)[0-9]+/);
    expect(gradient).toContain("color-mix(in oklch, var(--ink) 20%, transparent)");
    expect(gradient.startsWith("repeating-linear-gradient(45deg,")).toBe(true);
  });
});

describe("closed weeks on card and row", () => {
  const flat = (s: string) => s.replace(/<!-- -->/g, "");
  const CLOSE = {
    provider: "kimi",
    plan: "p",
    usedPct: 88,
    leftoverPct: 12,
    sampledAt: "2026-09-07T09:04:00+10:00",
    periodStart: "2026-08-31T12:25:00+10:00",
    resetsAt: "2026-09-10T12:25:00+10:00",
    resetsAtEstimated: false,
    detectedAt: "2026-09-10T12:40:00+10:00",
    reason: "usage-drop" as const,
  };

  it("shows last week's leftover inside the card foot, omitted with no close", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const withClose = { ...kimi, lastCloses: [CLOSE] };
    const html = flat(renderToString(
      React.createElement(ProviderCard, { provider: withClose, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    expect(html).toContain("Last week 12% leftover");
    const body = html.slice(html.indexOf("pcard-body"), html.indexOf("pcard-foot"));
    expect(body).not.toContain("leftover");
    expect(html.slice(html.indexOf("pcard-foot"))).toContain("Last week 12% leftover");

    const noClose = flat(renderToString(
      React.createElement(ProviderCard, { provider: { ...kimi, lastCloses: [] }, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    expect(noClose).not.toContain("leftover");
  });

  it("marks estimated closes on card and row", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const estimated = { ...kimi, lastCloses: [{ ...CLOSE, resetsAtEstimated: true }] };
    const card = flat(renderToString(
      React.createElement(ProviderCard, { provider: estimated, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    expect(card).toContain("Last week 12% leftover (est.)");
    const row = flat(renderToString(
      React.createElement(ProviderRow, { provider: estimated, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    expect(row).toContain("last week 12% leftover (est.)");
  });

  it("shows last week's leftover in the ledger reset cell, never in used vs elapsed", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const withClose = { ...kimi, lastCloses: [CLOSE] };
    const row = flat(renderToString(
      React.createElement(ProviderRow, { provider: withClose, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    const usedCol = row.slice(row.indexOf('data-label="Used vs elapsed"'), row.indexOf('data-label="Reset"'));
    expect(usedCol).not.toContain("leftover");
    const resetCell = row.slice(row.indexOf('data-label="Reset"'), row.indexOf('data-label="Pace"'));
    expect(resetCell).toContain("last week 12% leftover");

    const noClose = flat(renderToString(
      React.createElement(ProviderRow, { provider: { ...kimi, lastCloses: [] }, recommended: false, asOf: s.asOf, onSelect: () => {} }),
    ));
    expect(noClose).not.toContain("leftover");
  });
});

describe("recommended sort", () => {
  it("puts use first, then lane members, then the rest, excluded last", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const ids = sortProviders(s.providers, "recommended", s.recommendation).map((p: any) => p.id);
    expect(ids).toEqual(["my-plan", "claude", "codex", "kimi", "agy", "agy:3p", "grok", "manual"]);
  });
  it("sorts resets and usage by server fields only", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const byReset = sortProviders(s.providers, "reset-asc", s.recommendation).map((p: any) => p.id);
    expect(byReset[byReset.length - 1]).toBe("manual"); // no quota sorts last
    expect(byReset).toContain("grok"); // invalid reset still listed, after valid dates
    expect(byReset.indexOf("grok")).toBeGreaterThan(byReset.indexOf("kimi"));
    const byUsed = sortProviders(s.providers, "used-desc", s.recommendation).map((p: any) => p.id);
    expect(byUsed[0]).toBe("agy:3p"); // 60% used
  });
});

describe("monthly headline", () => {
  const go = (json: string) => toViewModel(JSON.parse(json)).providers.find((p) => p.id === "opencode-go")!;
  const bar = (json: string) => renderToString(
    React.createElement(PaceBar, { provider: go(json), asOf: JSON.parse(json).asOf }),
  ).replace(/<!-- -->/g, "");

  it("binds with leftover: → 5% of month left, behind colour, no hatch", () => {
    const html = bar(monthlyStateSnapshotJson);
    expect(html).toContain("out-behind");
    expect(html).toContain("→ 5% of month left");
    expect(html).not.toContain("pace-hatch");
    expect(html).not.toContain("expires unused");
  });

  it("empty month: → unused until Tue Sep 15, cap colour, no hatch, red badge", () => {
    const html = bar(monthlyExhaustedStateSnapshotJson);
    expect(html).toContain("out-cap");
    expect(html).toContain("→ unused until Tue Sep 15");
    expect(html).not.toContain("pace-hatch");
    const badge = renderToString(React.createElement(Badge, { provider: go(monthlyExhaustedStateSnapshotJson) }));
    expect(badge).toContain("pace-cap");
    expect(badge).toContain("Monthly exhausted");
  });
});
