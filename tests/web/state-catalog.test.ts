import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleStateSnapshotJson,
  resetPassedStateSnapshotJson,
  unknownPaceStateSnapshotJson,
} from "../fixtures/stable-state.js";
import {
  loadState,
  StateHttpError,
  StateNetworkError,
} from "../../web/src/api.js";
import { firstRun, toViewModel } from "../../web/src/state.js";
import { Recommendation, lanesFor } from "../../web/src/components/Recommendation.js";
import { SubscriptionList } from "../../web/src/components/SubscriptionList.js";
import { ResetRail } from "../../web/src/components/ResetRail.js";
import { ProviderDrawer } from "../../web/src/components/ProviderDrawer.js";
import { Header } from "../../web/src/components/Header.js";
import { FaultBanner } from "../../web/src/components/FaultBanner.js";
import { Onboarding } from "../../web/src/pages/Onboarding.js";
import { resetCountdown } from "../../web/src/components/PaceBar.js";
import App from "../../web/src/App.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("state catalog: fetch branches", () => {
  it("maps network failure to service-unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(loadState()).rejects.toBeInstanceOf(StateNetworkError);
  });
  it("maps HTTP errors to status plus the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Broken",
        json: async () => ({ error: "boom" }),
      })
    );
    const err = await loadState().catch((e) => e);
    expect(err).toBeInstanceOf(StateHttpError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("boom");
  });
  it("loads the snapshot when the server answers", async () => {
    const snap = JSON.parse(exampleStateSnapshotJson);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => snap }));
    await expect(loadState()).resolves.toEqual(snap);
  });
});

describe("state catalog: mapping over fixtures", () => {
  it("detects first run, partial failure, and reset-passed rows", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    expect(firstRun(s)).toBe(false);
    expect(firstRun({ providers: [{ quota: null }] })).toBe(true);
    // Partial failure: reportable and excluded rows coexist.
    expect(s.providers.some((p: any) => p.exclusionReason === null)).toBe(true);
    expect(s.providers.some((p: any) => p.exclusionReason !== null)).toBe(true);
    const r = JSON.parse(resetPassedStateSnapshotJson);
    const kimi = r.providers.find((p: any) => p.id === "kimi");
    expect(kimi.exclusionReason).toBe("reset-passed");
    expect(resetCountdown(kimi, Date.parse(r.asOf))).toBe("awaiting fresh window");
  });
  it("marks estimated resets and unknown pace without forecasting", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const codex = s.providers.find((p: any) => p.id === "codex");
    expect(resetCountdown(codex, Date.parse(s.asOf))).toMatch(/\(est\.\)/);
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    const kimi = u.providers.find((p: any) => p.id === "kimi");
    expect(kimi.advisory.paceSource).toBe("unknown");
    expect(kimi.advisory.wastePct).toBeNull();
  });
  it("renders the balanced state with empty lanes", () => {
    const advisory = {
      provider: "kimi",
      daysLeft: 7,
      remaining: 60,
      idealRate: 8.5,
      burnRate: 8.5,
      burnMeasured: false,
      paceSource: "window-average",
      daysToExhaust: 7,
      status: "on track",
      wastePct: 0,
      urgency: "on track",
    };
    const recommendation = {
      use: "none",
      reason: "No subscription needs priority",
      wastePct: 0,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: [advisory],
    };
    const html = renderToString(
      React.createElement(Recommendation, {
        recommendation: recommendation as any,
        providers: [{ id: "kimi", exclusionReason: null }] as any,
        asOf: "2026-09-07T06:00:00+10:00",
      })
    );
    expect(html).toContain("No subscription needs priority");
    expect(html).not.toContain("lane-use-more");
    expect(html).not.toContain("lane-ease-off");
    expect(lanesFor([advisory] as any, [{ id: "kimi", exclusionReason: null }] as any)).toEqual({
      useMore: [],
      easeOff: [],
    });
  });
});

describe("state catalog: server-rendered components", () => {
  it("prints the server recommendation verbatim with lanes", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const html = renderToString(
      React.createElement(Recommendation, {
        recommendation: s.recommendation,
        providers: s.providers,
        asOf: s.asOf,
      })
    );
    expect(html).toContain(s.recommendation.reason);
    expect(html).toContain("lane-use-more");
    expect(html).toContain("USE MORE");
  });
  it("renders badges, counts, and unknown pace without predicted waste", () => {
    const s = toViewModel(JSON.parse(unknownPaceStateSnapshotJson));
    const html = renderToString(
      React.createElement(SubscriptionList, {
        providers: s.providers,
        recommendation: s.recommendation,
        asOf: s.asOf,
        onSelectProvider: () => {},
      })
    );
    expect(html).toContain("Behind pace");
    expect(html).toContain("Not reporting");
    expect(html).toContain("On track");
    expect(html).toMatch(/7(<!-- -->)? tracked/);
    expect(html).toContain("Measuring pace");
    expect(html).not.toContain("predicted");
  });
  it("renders the rail cluster, live pill, and fault banners", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const rail = renderToString(
      React.createElement(ResetRail, {
        providers: s.providers,
        asOf: s.asOf,
        onSelectProvider: () => {},
      })
    );
    expect(rail).toContain("cluster-pin");
    expect(rail).toContain("6 resets");
    const header = renderToString(
      React.createElement(Header, {
        runtime: s.runtime,
        refreshing: false,
        onRefresh: () => {},
        onSettings: () => {},
      })
    );
    expect(header).toContain('data-state="live"');
    expect(header).toContain("Daemon active");
    const banners = renderToString(
      React.createElement(FaultBanner, {
        providers: s.providers,
        onRepoll: () => {},
        repolling: false,
      })
    );
    expect(banners).toContain("fault-banner");
    expect(banners).toContain("stopped reporting"); // agy:3p stale
    expect(banners).toContain("invalid reading"); // grok invalid
    expect(banners).not.toContain("manual"); // disabled providers never banner
  });
  it("renders drawer fields and onboarding without synthesis", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const codex = s.providers.find((p) => p.id === "codex")!;
    const drawer = renderToString(
      React.createElement(ProviderDrawer, { provider: codex, onClose: () => {} })
    );
    expect(drawer).toContain("Window avg");
    expect(drawer).toContain("(est.)");
    expect(drawer).not.toContain("Session reset");
    const first = {
      ...s,
      providers: [
        {
          id: "claude",
          enabled: true,
          quota: null,
          lastAttempt: null,
          lastSuccessAt: null,
          reporting: false,
          stale: false,
          resetPassed: false,
          ageMs: null,
          evidence: [],
          exclusionReason: "not-reporting",
          advisory: null,
        },
      ],
    };
    expect(firstRun(first)).toBe(true);
    const setup = renderToString(
      React.createElement(Onboarding, {
        snapshot: first as any,
        onFirstPoll: () => {},
        polling: false,
        pollError: null,
      })
    );
    expect(setup).toContain("setup-step-1");
    expect(setup).toContain("Sign in first");
    expect(setup).toContain("never handles those credentials");
  });
  it("shows skeleton loading before the first snapshot", () => {
    const html = renderToString(React.createElement(App));
    expect(html).toContain("state-loading");
    expect(html).toContain('data-state="connecting"');
  });
});
