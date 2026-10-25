import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { exampleStateSnapshotJson, unknownPaceStateSnapshotJson, monthlyStateSnapshotJson, monthlyExhaustedStateSnapshotJson, boardMonthlyStateSnapshotJson } from "../fixtures/stable-state.js";
import { laneOf, lanesFor } from "../../web/src/components/Recommendation.js";
import { forecastLine } from "../../web/src/components/PaceBar.js";
import { toViewModel } from "../../web/src/state.js";
import { Recommendation } from "../../web/src/components/Recommendation.js";
import { sortProviders as webSort } from "../../web/src/components/SubscriptionList.js";
import { sortProviders as cliSort } from "../../src/format/rows.js";

describe("recommendation lanes", () => {
  it("lanes follow server urgency, never recompute waste", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    for (const a of s.recommendation.advisories) {
      if (a.urgency === "burn now" || a.urgency === "use soon" || a.urgency === "save") {
        expect(laneOf(a, null)).toBe("use-more");
      }
      if (a.urgency === "slow down") expect(laneOf(a, null)).toBe("ease-off");
      if (a.urgency === "on track") expect(laneOf(a, null)).toBeNull();
    }
  });
  it("a used-up quota sits in no lane", () => {
    expect(laneOf({ urgency: "slow down", remaining: 0 }, null)).toBeNull();
    expect(laneOf({ urgency: "slow down", remaining: 4 }, null)).toBe("ease-off");
  });
  it("excluded providers never lane, unknown pace never forecasts", () => {
    expect(laneOf({ urgency: "burn now" }, "stale")).toBeNull();
    expect(laneOf({ urgency: "burn now" }, "reset-passed")).toBeNull();
    expect(laneOf({ urgency: "slow down" }, "invalid")).toBeNull();
    // The unknown-pace fixture keeps my-plan recommended at 76% waste; only
    // kimi's pace is unknown, so kimi carries no forecast fields and no lane.
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    const kimi = u.providers.find((p: any) => p.id === "kimi");
    expect(kimi.advisory.paceSource).toBe("unknown");
    expect(kimi.advisory.wastePct).toBeNull();
    expect(kimi.advisory.burnRate).toBeNull();
    expect(laneOf(kimi.advisory, kimi.exclusionReason)).toBeNull();
  });
  it("prints unused-quota copy from server wastePct, never a client forecast", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const pick = s.providers.find((p: any) => p.id === s.recommendation.use);
    expect(pick.advisory.wastePct).toBe(s.recommendation.wastePct);
    expect(forecastLine(pick)).toContain(`${Math.round(pick.advisory.wastePct)}%`);
    expect(forecastLine(pick)).toContain("unused at reset");
  });
});

describe("monthly-bound pick", () => {
  it("the Use-next strip prints the reason, never the weekly waste forecast, and no Measuring badge", () => {
    const s = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    expect(s.recommendation.bindingWindow).toBe("monthly");
    const html = renderToString(React.createElement(Recommendation, {
      recommendation: s.recommendation, providers: s.providers, asOf: s.asOf,
    })).replace(/<!-- -->/g, "");
    expect(html).toContain("5% of month left in 8d 16h");
    expect(html).not.toContain("unused at reset");
    expect(html).not.toContain("Measuring");
  });
});

describe("a blocked month never lanes", () => {
  it("laneOf returns null at monthly remaining 0 and lanes normally with leftover", () => {
    expect(laneOf({ urgency: "save", bindingWindow: "monthly", bindingRemaining: 0 }, null)).toBeNull();
    expect(laneOf({ urgency: "save", bindingWindow: "monthly", bindingRemaining: 5 }, null)).toBe("use-more");
    expect(laneOf({ urgency: "save" }, null)).toBe("use-more"); // older advisory shape
  });

  it("the exhausted fixture has weekly urgency save but lands in no lane", () => {
    const s = toViewModel(JSON.parse(monthlyExhaustedStateSnapshotJson));
    expect(s.providers[0].advisory!.urgency).toBe("save");
    const { useMore, easeOff } = lanesFor(s.recommendation.advisories, s.providers);
    expect([...useMore, ...easeOff].map((a) => a.provider)).not.toContain("opencode-go");
  });

  it("both recommended sorts place it with the excluded rows", () => {
    const raw = JSON.parse(boardMonthlyStateSnapshotJson);
    const go = raw.providers.find((p: any) => p.id === "opencode-go");
    go.quota.monthlyStatus = "exhausted";
    go.quota.monthlyPct = 100;
    go.advisory.bindingWindow = "monthly";
    go.advisory.bindingRemaining = 0;
    const adv = raw.recommendation.advisories.find((a: any) => a.provider === "opencode-go");
    Object.assign(adv, { bindingWindow: "monthly", bindingRemaining: 0 });
    const lastOpen = (ids: string[], excluded: Set<string>) =>
      Math.max(...ids.map((id, i) => (excluded.has(id) ? -1 : i)));
    const excluded = new Set<string>(raw.providers.filter((p: any) => p.exclusionReason !== null).map((p: any) => p.id));

    const cli = cliSort(raw.providers, "recommended", raw.recommendation.use).map((p) => p.id);
    expect(cli.indexOf("opencode-go")).toBeGreaterThan(lastOpen(cli, new Set([...excluded, "opencode-go"])));

    const view = toViewModel(raw);
    const web = webSort(view.providers, "recommended", view.recommendation).map((p) => p.id);
    expect(web.indexOf("opencode-go")).toBeGreaterThan(lastOpen(web, new Set([...excluded, "opencode-go"])));
  });
});

describe("lane chip on a full short window", () => {
  function render(mutate?: (p: any, asOfMs: number) => void) {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const { useMore, easeOff } = lanesFor(s.recommendation.advisories, s.providers);
    const member = [...useMore, ...easeOff][0];
    const provider = s.providers.find((p) => p.id === member.provider)!;
    mutate?.(provider, Date.parse(s.asOf));
    const html = renderToString(React.createElement(Recommendation, {
      recommendation: s.recommendation, providers: s.providers, asOf: s.asOf,
    })).replace(/<!-- -->/g, "");
    return { html, id: provider.id };
  }

  it("names when a laned provider blocked by its 5h limit is back", () => {
    const { html, id } = render((p, asOfMs) => {
      p.quota = { ...p.quota, fiveHourPct: 100, fiveHourResetsAt: new Date(asOfMs + 2 * 3_600_000).toISOString() };
    });
    expect(html).toMatch(new RegExp(`data-testid="lane-wait-${id}"><span class="rwait-sep"> · </span>back <b>[A-Z][a-z]{2} \\d{2}:\\d{2}</b>`));
  });

  it("stays quiet when no short window is full", () => {
    const { html } = render();
    expect(html).not.toContain("lane-wait-");
  });
});
