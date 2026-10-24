import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, staleStateSnapshotJson, unknownPaceStateSnapshotJson, monthlyStateSnapshotJson, monthlyExhaustedStateSnapshotJson } from "../fixtures/stable-state.js";
import { providerSubtitle, toViewModel } from "../../web/src/state.js";
import {
  compactLimitForecast,
  credentialLabel,
  drawerModel,
  fiveHourElapsedPct,
  forecastBasis,
  fiveHourResetLine,
  monthlyElapsedPct,
  monthlyMeta,
  paceBasis,
  sourceLabel,
  verdictFor,
  windowElapsedPct,
} from "../../web/src/components/ProviderDrawer.js";
import {
  ProviderDrawer,
  submitProviderRename,
} from "../../web/src/components/ProviderDrawer.js";
import { closeDateLabel, closeResetStamp, closeSampleStamp } from "../../web/src/components/ClosedWeeks.js";
import { clockText } from "../../src/format/time.js";
import { BurnDown, burnGeometry } from "../../web/src/components/BurnDown.js";
import { renameProvider } from "../../web/src/api.js";

describe("provider drawer", () => {
  it("exposes server fields without synthesis", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const m = drawerModel(s.providers.find((p: any) => p.id === "codex"));
    expect(m.estimatedReset).toBe(true);
    expect(m.evidence).toContain("estimated-reset");
    expect(m.fiveHourResetsAt).toBeUndefined(); // absent unless reported
  });
  it("marks unknown pace and exclusion reasons in plain words", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const invalid = drawerModel(s.providers.find((p: any) => p.id === "grok"));
    expect(invalid.exclusionReason).toBe("invalid");
    expect(invalid.exclusionWords).toMatch(/invalid/i);
    expect(invalid.burnRate).toBeNull();
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    const kimi = drawerModel(u.providers.find((p: any) => p.id === "kimi"));
    expect(kimi.paceSource).toBe("unknown");
    expect(kimi.burnRate).toBeNull();
    expect(kimi.wastePct).toBeNull();
  });
  it("drawerModel uses lastAttempt summary when failureCategory is unknown", () => {
    const p = {
      id: "muse",
      displayName: "Muse",
      evidence: [],
      exclusionReason: "provider-failed",
      lastAttempt: {
        provider: "muse",
        attemptedAt: "2026-10-20T04:43:00Z",
        completedAt: "2026-10-20T04:43:00Z",
        succeededAt: null,
        success: false,
        failureCategory: "unknown",
        summary: "Muse usage currently unavailable",
      },
    } as any;
    const m = drawerModel(p);
    expect(m.failureWords).toBe("Muse usage currently unavailable");
  });
  it("drawer renders 0% for 5h limit when fiveHourResetsAt has passed and red cap for 100% weekly", () => {
    const asOf = "2026-10-20T04:43:00.000Z";
    const p = {
      id: "muse",
      displayName: "Muse",
      evidence: [],
      exclusionReason: "provider-failed",
      lastAttempt: null,
      quota: {
        provider: "muse",
        weeklyPct: 100,
        fiveHourPct: 82,
        fiveHourResetsAt: "2026-10-20T02:56:00.000Z",
        resetsAt: "2026-10-26T00:00:00.000Z",
        source: "tui",
        fetchedAt: "2026-10-20T02:46:00.000Z",
      },
    } as any;
    const html = renderToString(React.createElement(ProviderDrawer, {
      provider: p,
      asOf,
      recommendation: null,
      onClose: () => {},
    })).replace(/<!-- -->/g, "");
    expect(html).toContain("0% used");
    expect(html).not.toContain("82% used");
    expect(html).toContain("var(--fill-cap)");
  });
  it("labels adapter source without inventing credential paths", () => {
    expect(sourceLabel("cli")).toBe("Live CLI");
    expect(sourceLabel("tui")).toBe("Live TUI");
    expect(sourceLabel("manual")).toBe("Manual ingest");
  });
  it("labels the opencode-go api source as an in-memory opt-in read", () => {
    const p = { id: "opencode-go", displayName: "OpenCode Go", quota: { source: "api" } } as any;
    expect(credentialLabel(p)).toBe("read in-memory from OpenCode auth (opt-in), never stored");
  });
  it("renders the concept drawer sections from snapshot fields", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    expect(paceBasis(kimi, Date.parse(s.asOf))).toMatch(/averaged over|Window avg|Measured/);
    expect(verdictFor(kimi, Date.parse(s.asOf))).toEqual({
      tone: "use-more",
      label: "↑ Use more",
      detail: "56% unused at reset (Mon 14 Sep 06:00)",
    });
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Limits");
    expect(html).toContain("Weekly limit");
    expect(html).not.toContain("Adapter and provenance");
    expect(html).not.toContain("Ranking rationale");
    expect(html).not.toContain("Raw JSON");
    expect(html).not.toContain("Copy JSON");
    expect(html).toContain('class="verdict use-more"');
    expect(html).toContain("↑ Use more");
    expect(html).toContain("56% unused at reset");
    expect(html).toContain('class="drawer-desc"');
    expect(html).toContain('class="winrow-sub reset-line"');
    expect(html).toContain("<strong>");
    // The projected-waste forecast rides the quota row, wording as on the card.
    const limitsSlice = html.slice(html.indexOf("<h3>Limits</h3>"), html.indexOf("prov-foot"));
    expect(limitsSlice).toContain("unused at reset");
    // The quota bar hatches the projected-unused share, like the card bar.
    expect(limitsSlice).toContain('data-testid="limit-hatch"');
    expect(limitsSlice).toContain('class="band band-waste"');
    expect(html).toContain('class="prov-foot"');
    expect(html).toContain("Live CLI");
    expect(html).toContain("Updated 1m ago");
    expect(html).not.toContain("Credential");
    expect(html).not.toContain("handled by Kimi");
    expect(html).not.toContain("kimi-code.json");
    expect(html).not.toContain("Burn rate");
    // Healthy providers render no Notes section.
    expect(html).not.toContain('aria-label="Notes"');
  });
  it("displays the 5h limit row inside the merged Limits section", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const claude = s.providers.find((p) => p.id === "claude")!;
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: claude,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Limits");
    expect(html).toContain("5h limit");
    expect(html).toContain('class="limit-row"');
    expect(html.replace(/<!-- -->/g, "")).toContain("22%");
    const windows = html.slice(html.indexOf('aria-label="Limits"'), html.indexOf("prov-foot"));
    expect(windows).toContain("5h limit");
    // Rolling-limit fills stay neutral below the cap threshold: green
    // would imply a pace judgement the drawer does not make for them.
    const fiveRow = windows.slice(windows.indexOf("5h limit"), windows.indexOf("limit-legend"));
    expect(fiveRow).toContain("background:var(--fill-out)");
    // Without a reported 5h reset, the row says so instead of a reset line.
    expect(fiveRow).toContain("Reset not reported");
    expect(fiveRow).not.toContain("Resets");
    // No row carries a "Rate limit" label; the quota row alone is tagged.
    expect(windows).not.toContain("Rate limit");
    expect(windows.match(/quota-tag/g)).toHaveLength(1);
    expect(windows).toContain("Quota reset");
    // The legend, divided from the rows, explains the bar marks.
    expect(windows).toContain('class="mark"');
    expect(windows).toContain('class="limit-legend"');
    expect(windows).toContain("Legend");
    expect(windows).toContain("Time elapsed");
    expect(windows).toContain("Projected waste");
    expect(windows).toContain('class="legend-hatch"');
  });

  it("shows a reported 5h reset as a quieter sub-line", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const base = s.providers.find((p) => p.id === "claude")!;
    const asOfMs = Date.parse(s.asOf);
    const withReset = {
      ...base,
      quota: {
        ...base.quota!,
        fiveHourResetsAt: new Date(asOfMs + (3 * 60 + 24) * 60000).toISOString(),
      },
    };
    expect(fiveHourResetLine(withReset as any, asOfMs)).toMatch(/Resets .* · in 3h 24m/);
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: withReset,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('class="winrow-sub reset-line"');
    expect(html).toMatch(/Resets <strong>.*<\/strong> · in <strong>3h 24m<\/strong>/);
    // The 5h bar carries the elapsed mark derived from the reported reset.
    expect(html).toContain('title="Time elapsed: 32%"');
    expect(drawerModel({ ...base, quota: withReset.quota } as any).fiveHourResetsAt)
      .toBe(withReset.quota.fiveHourResetsAt);
  });
  it("renders 5h limit even when 0% used, and omits it when provider reports no short window", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const zeroSession = {
      ...s.providers.find((p) => p.id === "claude")!,
      quota: { ...s.providers.find((p) => p.id === "claude")!.quota!, fiveHourPct: 0 },
    };
    const htmlZero = renderToString(
      React.createElement(ProviderDrawer, {
        provider: zeroSession,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(htmlZero).toContain("5h limit");
    expect(htmlZero).toContain('class="limit-row"');
    expect(htmlZero.replace(/<!-- -->/g, "")).toContain("0%");

    const grok = s.providers.find((p) => p.id === "grok")!;
    const htmlGrok = renderToString(
      React.createElement(ProviderDrawer, {
        provider: grok,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(htmlGrok).not.toContain("5h limit");
  });
  it("names the forecast rate only when it blends two inputs", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const blended = { ...kimi, advisory: { ...kimi.advisory!, burnRate: 11.56, recentRate: 19.4, baselineRate: 3.71, bindingWindow: "weekly" } };
    expect(forecastBasis(blended as any)).toBe("forecast 11.6%/day (24h blended with history)");
    const single = { ...blended, advisory: { ...blended.advisory, recentRate: null } };
    expect(forecastBasis(single as any)).toBeNull();
  });
  it("derives the ease-off verdict with the shared duration formatter", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const risky = {
      ...kimi,
      advisory: { ...kimi.advisory!, status: "at risk", urgency: "slow down", daysToExhaust: 2.4 },
    };
    expect(verdictFor(risky as any, Date.parse(s.asOf))).toEqual({
      tone: "ease-off",
      label: "↓ Ease off",
      detail: "exhausts in 2d 9h at forecast pace",
    });
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: risky as any,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain('class="verdict ease-off"');
    expect(html).toContain("exhausts in 2d 9h at forecast pace");
    // The limit line keeps only the outcome, without the status prefix.
    const limits = html.slice(html.indexOf("<h3>Limits</h3>"), html.indexOf("prov-foot")).replace(/<!-- -->/g, "");
    expect(limits).toContain("→ exhausts in 2d 9h");
    expect(limits).not.toContain("Cap risk ·");
    expect(compactLimitForecast(risky as any)?.text).toBe("exhausts in 2d 9h");
    // A status-only headline and an on-track headline stay off the row.
    const noClock = { ...risky, advisory: { ...risky.advisory, daysToExhaust: null } };
    expect(compactLimitForecast(noClock as any)).toBeNull();
    const onTrack = {
      ...kimi,
      advisory: { ...kimi.advisory!, status: "on track", urgency: "on track", wastePct: null, daysToExhaust: null },
    };
    expect(compactLimitForecast(onTrack as any)).toBeNull();
  });
  it("renders a fresh window where both pace figures are unknown", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    // Fresh window with a history baseline: burnRate set, avgPace null
    // (<6h elapsed), recentRate null (no 24h span). The old rationale
    // called toFixed on the null figure and blanked the dashboard on
    // Inspect; the verdict band is the new surface for this provider.
    const fresh = {
      ...kimi,
      advisory: {
        ...kimi.advisory!,
        burnRate: 5.2,
        recentRate: null,
        baselineRate: 5.2,
        avgPace: null,
        burnMeasured: false,
        paceSource: "window-average",
        status: "on track",
      },
    };
    expect(verdictFor(fresh as any, Date.parse(s.asOf)).tone).toBe("use-more");
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: fresh as any,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain('class="verdict use-more"');
    expect(html).toContain("unused at reset");
    expect(html).not.toContain("NaN");
  });
  it("names Watch rows as ease-off instead of on-track copy", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const watchOnTrack = {
      ...kimi,
      advisory: { ...kimi.advisory!, status: "watch", urgency: "on track", daysToExhaust: 2.1 },
    };
    expect(verdictFor(watchOnTrack as any, Date.parse(s.asOf))).toEqual({
      tone: "ease-off",
      label: "↓ Ease off",
      detail: "exhausts in 2d 2h at forecast pace",
    });
    const watchNoClock = { ...watchOnTrack, advisory: { ...watchOnTrack.advisory, daysToExhaust: null } };
    expect(verdictFor(watchNoClock as any, Date.parse(s.asOf)).detail).toBe("Watch");
  });
  it("names exhausted windows in the verdict", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const capped = {
      ...kimi,
      quota: { ...kimi.quota!, weeklyPct: 100 },
      advisory: {
        ...kimi.advisory!,
        remaining: 0,
        burnRate: 0,
        avgPace: 14.3,
        status: "at risk",
        urgency: "slow down",
        wastePct: 0,
        daysToExhaust: 0,
      },
    };
    const verdict = verdictFor(capped as any, Date.parse(s.asOf));
    expect(verdict.tone).toBe("neutral");
    expect(verdict.label).toBe("• Capped");
    expect(verdict.detail).toMatch(/^until \w{3} \d{2}:\d{2}$/);
  });
  it("derives excluded, monthly-bound, monthly-exhausted, and on-track verdicts", () => {
    const stale = toViewModel(JSON.parse(staleStateSnapshotJson));
    const staleKimi = stale.providers.find((p) => p.id === "kimi")!;
    expect(verdictFor(staleKimi, Date.parse(stale.asOf))).toEqual({
      tone: "neutral",
      label: "• Not ranked",
      detail: "stale · last read 3h 0m ago",
    });
    const monthly = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const go = monthly.providers.find((p) => p.id === "opencode-go")!;
    expect(verdictFor(go, Date.parse(monthly.asOf))).toEqual({
      tone: "use-more",
      label: "↑ Use more",
      detail: "5% of month left",
    });
    const exhausted = toViewModel(JSON.parse(monthlyExhaustedStateSnapshotJson));
    const goEx = exhausted.providers.find((p) => p.id === "opencode-go")!;
    expect(verdictFor(goEx, Date.parse(exhausted.asOf))).toEqual({
      tone: "neutral",
      label: "• Not ranked",
      detail: "unused until Tue 15 Sep",
    });
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const onTrack = {
      ...kimi,
      advisory: { ...kimi.advisory!, status: "on track", urgency: "on track", wastePct: null },
    };
    expect(verdictFor(onTrack as any, Date.parse(s.asOf))).toEqual({
      tone: "neutral",
      label: "• On track",
      detail: "On track.",
    });
  });
  it("shows Notes above Windows only when exclusion, failure, or estimated reset is present", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const codex = s.providers.find((p) => p.id === "codex")!;
    const codexHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: codex,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(codexHtml).toContain('aria-label="Notes"');
    expect(codexHtml).toContain("Reset time is estimated.");
    expect(codexHtml.indexOf('aria-label="Notes"')).toBeLessThan(codexHtml.indexOf('aria-label="Limits"'));
    const stale = toViewModel(JSON.parse(staleStateSnapshotJson));
    const staleKimi = stale.providers.find((p) => p.id === "kimi")!;
    const staleHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: staleKimi,
        asOf: stale.asOf,
        recommendation: stale.recommendation,
        onClose: () => {},
      })
    );
    expect(staleHtml).toContain('aria-label="Notes"');
    expect(staleHtml).toContain("Stale");
    expect(staleHtml.indexOf('aria-label="Notes"')).toBeLessThan(staleHtml.indexOf('aria-label="Limits"'));
  });
  it("renders the provenance footer with the credential line only for opencode-go api", () => {
    const monthly = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const go = monthly.providers.find((p) => p.id === "opencode-go")!;
    const goHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: go,
        asOf: monthly.asOf,
        recommendation: monthly.recommendation,
        onClose: () => {},
      })
    );
    expect(goHtml).toContain('class="prov-foot"');
    expect(goHtml).toContain("Live API");
    expect(goHtml).toContain("Updated 1m ago");
    expect(goHtml).toContain("read in-memory from OpenCode auth (opt-in), never stored");
    expect(goHtml).not.toContain("Adapter and provenance");
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const kimiHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(kimiHtml).not.toContain("read in-memory from OpenCode auth");
    // Stale footer appends the failure words.
    const stale = toViewModel(JSON.parse(staleStateSnapshotJson));
    const staleKimi = stale.providers.find((p) => p.id === "kimi")!;
    const failed = {
      ...staleKimi,
      lastAttempt: { ...staleKimi.lastAttempt!, failureCategory: "timeout" as const, success: false },
    };
    const failedHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: failed as any,
        asOf: stale.asOf,
        recommendation: stale.recommendation,
        onClose: () => {},
      })
    );
    const foot = failedHtml.slice(failedHtml.indexOf('class="prov-foot"'));
    expect(foot).toContain("Timed out");
  });
  it("ports the verdict, limit rows, notes, footer, and rename CSS from the mock", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.verdict \{[^}]*display: flex/);
    expect(css).toMatch(/\.verdict\.use-more \{[^}]*background: var\(--warn-soft\)/);
    expect(css).toMatch(/\.verdict\.ease-off \{[^}]*background: var\(--danger-soft\)/);
    expect(css).toMatch(/\.verdict\.neutral \{[^}]*background: var\(--surface-raised\)/);
    expect(css).toMatch(/\.limit-head \{[^}]*display: flex/);
    expect(css).toMatch(/\.notes-list \{[^}]*display: grid/);
    expect(css).toMatch(/\.prov-foot \{[^}]*font-size: var\(--t-2\)/);
    expect(css).toMatch(/\.rename-btn \{[^}]*width: 28px/);
  });
  it("adds the derived subtitle and the authored description", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    expect(providerSubtitle(kimi)).toBe("Kimi Code · Moonshot AI");
    const agy = s.providers.find((p) => p.id === "agy")!;
    expect(providerSubtitle(agy)).toBe("Google");
    const unknown = s.providers.find((p) => p.id === "my-plan")!;
    expect(providerSubtitle(unknown)).toBeNull();
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Kimi Code · Moonshot AI");
    expect(html).toContain("Kimi Code subscription, metered as weekly and 5-hour windows.");
    const bare = renderToString(
      React.createElement(ProviderDrawer, {
        provider: unknown,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    // No stray null/undefined may reach the rendered words.
    expect(bare).not.toContain("undefined");
    expect(bare).not.toContain("null");
  });

  it("renders Built-in: label when provider has an active override", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const overridden = {
      ...kimi,
      displayName: "My Fast Kimi",
      builtinName: "Kimi",
    };
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: overridden,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("My Fast Kimi");
    expect(html).toContain("Built-in: Kimi");
  });

  it("does not render Built-in: label when provider name matches builtinName or builtinName is null", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).not.toContain("Built-in:");

    const unknown = {
      ...kimi,
      id: "unknown-prov",
      displayName: "unknown-prov",
      builtinName: null,
    };
    const unknownHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: unknown,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(unknownHtml).not.toContain("Built-in:");
  });

  it("renders an inline rename affordance for the provider name", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Rename Kimi");
    expect(html).toContain('class="rename-btn"');
    expect(html).not.toContain("Click to rename");
    expect(html).toMatch(/aria-labelledby="(provider-drawer-title)"/);
    const match = html.match(/aria-labelledby="([^"]+)"/);
    const titleId = match ? match[1] : "";
    expect(html).toContain(`id="${titleId}"`);
  });

  it("renameProvider sends PATCH /api/providers/:id with token and displayName", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "/api/token") {
          return new Response(JSON.stringify({ token: "test-token-123" }), { status: 200 });
        }
        if (url.startsWith("/api/providers/")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      await renameProvider("kimi", "Fast Kimi");
      expect(calls.length).toBe(2);
      expect(calls[0].url).toBe("/api/token");
      expect(calls[1].url).toBe("/api/providers/kimi");
      expect(calls[1].init?.method).toBe("PATCH");
      expect((calls[1].init?.headers as any)["X-QuotaCap-Token"]).toBe("test-token-123");
      expect(JSON.parse(calls[1].init?.body as string)).toEqual({ displayName: "Fast Kimi" });

      // Reset test with null
      await renameProvider("kimi", null);
      expect(calls.length).toBe(4);
      expect(calls[3].url).toBe("/api/providers/kimi");
      expect(JSON.parse(calls[3].init?.body as string)).toEqual({ displayName: null });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  describe("submitProviderRename", () => {
    it("trims non-empty input and calls renameFn with trimmed name", async () => {
      let calledWith: { id: string; name: string | null } | null = null;
      const result = await submitProviderRename("kimi", "  Work Kimi  ", async (id, name) => {
        calledWith = { id, name };
      });
      expect(calledWith).toEqual({ id: "kimi", name: "Work Kimi" });
      expect(result).toEqual({ success: true, error: null });
    });

    it("treats empty or whitespace-only input as null to restore built-in name", async () => {
      let calledWith: { id: string; name: string | null } | null = null;
      const result = await submitProviderRename("kimi", "   ", async (id, name) => {
        calledWith = { id, name };
      });
      expect(calledWith).toEqual({ id: "kimi", name: null });
      expect(result).toEqual({ success: true, error: null });
    });

    it("catches renameFn error and returns failure without throwing", async () => {
      const result = await submitProviderRename("kimi", "Bad Name", async () => {
        throw new Error("server validation failed");
      });
      expect(result).toEqual({ success: false, error: "server validation failed" });
    });
  });
});

describe("closed weeks drawer", () => {
  const flat = (s: string) => s.replace(/<!-- -->/g, "");

  function closeRow(over: any = {}) {
    return {
      provider: "claude",
      plan: "p",
      usedPct: 88,
      leftoverPct: 12,
      sampledAt: "2026-09-07T09:04:00+10:00",
      periodStart: "2026-08-31T12:25:00+10:00",
      resetsAt: "2026-09-10T12:25:00+10:00",
      resetsAtEstimated: false,
      detectedAt: "2026-09-10T12:40:00+10:00",
      reason: "usage-drop" as const,
      ...over,
    };
  }

  function claudeWith(closes: any[]) {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const claude = { ...s.providers.find((p) => p.id === "claude")!, lastCloses: closes };
    return { s, claude };
  }

  function render(claude: any, s: any) {
    return flat(
      renderToString(
        React.createElement(ProviderDrawer, {
          provider: claude,
          asOf: s.asOf,
          recommendation: s.recommendation,
          onClose: () => {},
        })
      )
    );
  }

  // Cell labels render in the machine's timezone; derive them like the drawer does.
  const label = (resetsAt: string) => closeDateLabel(resetsAt) ?? "";

  it("renders History bars after the live 5h window, with dated bars", () => {
    const { s, claude } = claudeWith([closeRow()]);
    const html = render(claude, s);
    expect(html).toContain("History");
    expect(html).not.toContain("Closed weeks");
    expect(html.indexOf("Limits")).toBeLessThan(html.indexOf("History"));
    expect(html.indexOf("5h limit")).toBeLessThan(html.indexOf("History"));
    expect(html).toContain('class="hchart"');
    expect(html).toContain('data-testid="closed-weeks"');
    expect(html).toContain('class="hgrid"');
    expect(html).toContain("100%");
    expect(html).toContain('class="hcol"');
    expect(html).toContain('class="hbars"');
    expect(html).toContain('class="hbar"');
    expect(html).toContain('class="solid"');
    expect(html).toContain("height:88%");
    expect(html).toContain('class="hatch"');
    expect(html).toContain("height:12%");
    expect(html).not.toContain('class="weeks"');
    expect(html).toContain(label("2026-09-10T12:25:00+10:00"));
    expect(html).toContain("12% leftover");
    expect(html).toContain(`88% used, 12% leftover, reset ${closeResetStamp("2026-09-10T12:25:00+10:00")}`);
    const history = html.slice(html.indexOf("History"), html.indexOf("prov-foot"));
    expect(history).not.toContain("band band-waste");
    expect(history).not.toMatch(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}/);
  });

  it("omits History when there is no close", () => {
    const { s, claude } = claudeWith([]);
    const html = render(claude, s);
    expect(html).not.toContain("History");
    expect(html).not.toContain('class="hchart"');
  });

  it("orders bars oldest left and newest right", () => {
    const { s, claude } = claudeWith([
      closeRow({ resetsAt: "2026-09-10T12:25:00+10:00", sampledAt: "2026-09-10T12:20:00+10:00", detectedAt: "2026-09-10T12:40:00+10:00" }),
      closeRow({ resetsAt: "2026-09-03T12:25:00+10:00", sampledAt: "2026-09-03T12:20:00+10:00", detectedAt: "2026-09-03T12:40:00+10:00" }),
      closeRow({ resetsAt: "2026-08-27T12:25:00+10:00", sampledAt: "2026-08-27T12:20:00+10:00", detectedAt: "2026-08-27T12:40:00+10:00" }),
      closeRow({ resetsAt: "2026-08-20T12:25:00+10:00", sampledAt: "2026-08-20T12:20:00+10:00", detectedAt: "2026-08-20T12:40:00+10:00" }),
    ]);
    const html = render(claude, s);
    expect(html.indexOf(label("2026-08-20T12:25:00+10:00"))).toBeLessThan(html.indexOf(label("2026-08-27T12:25:00+10:00")));
    expect(html.indexOf(label("2026-08-27T12:25:00+10:00"))).toBeLessThan(html.indexOf(label("2026-09-03T12:25:00+10:00")));
    expect(html.indexOf(label("2026-09-03T12:25:00+10:00"))).toBeLessThan(html.indexOf(label("2026-09-10T12:25:00+10:00")));
  });

  it("names an early reading on its bar label, with exact stamps only in the tooltip", () => {
    const { s, claude } = claudeWith([closeRow()]);
    const html = render(claude, s);
    expect(html).toContain("read 3d early");
    expect(html).toContain(closeSampleStamp("2026-09-07T09:04:00+10:00")!);
    expect(html).not.toContain("leftover is from the");
    expect(html).not.toContain("before that reset");
    expect(html).not.toContain("3 days before");
    expect(html).not.toContain("stale-note");
  });

  it("reads a one-hour-early sample in the compact label", () => {
    const resetsAt = "2026-09-10T12:25:00+10:00";
    const sampledAt = new Date(Date.parse(resetsAt) - 60 * 60_000).toISOString();
    const { s, claude } = claudeWith([closeRow({ sampledAt, resetsAt })]);
    const html = render(claude, s);
    expect(html).toContain("read 1h early");
    expect(html).not.toContain("1 hour before that reset");
    expect(html).not.toContain("1 hours");
  });

  it("floors the bar label earliness", () => {
    const resetsAt = "2026-09-10T12:25:00+10:00";
    const sampledAt = new Date(Date.parse(resetsAt) - 90 * 60_000).toISOString();
    const { s, claude } = claudeWith([closeRow({ sampledAt, resetsAt })]);
    const html = render(claude, s);
    expect(html).toContain("read 1h early");
    expect(html).not.toContain("read 2h early");
    expect(html).not.toContain("2 hours");
  });

  it("dates an early provider reset by when it happened and names it as a reset", () => {
    // Seen 2d 21h before the scheduled reset: the provider reset early.
    const { s, claude } = claudeWith([
      closeRow({
        sampledAt: "2026-09-07T13:00:00+10:00",
        detectedAt: "2026-09-07T15:25:00+10:00",
        resetsAt: "2026-09-10T12:25:00+10:00",
      }),
    ]);
    const html = render(claude, s);
    expect(html).toContain(`class="hlab">${label("2026-09-07T15:25:00+10:00")}`);
    expect(html).not.toContain(`class="hlab">${label("2026-09-10T12:25:00+10:00")}`);
    expect(html).toContain(`scheduled reset ${closeResetStamp("2026-09-10T12:25:00+10:00")}`);
    expect(html).toContain("reset 2d early");
    expect(html).not.toContain("read 2d early");
    expect(html).toContain("provider reset early");
  });

  it("ports the history bar CSS from the mock", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.hchart \{[^}]*display: flex/);
    expect(css).toMatch(/\.hgrid \{[^}]*border-top: 1px dashed var\(--line-strong\)/);
    expect(css).toMatch(/\.hbars \{[^}]*height: 84px/);
    expect(css).toMatch(/\.hbar \.hatch \{[^}]*repeating-linear-gradient/);
    expect(css).toMatch(/\.hbar \.solid \{[^}]*background: var\(--fill-out\)/);
    expect(css).toMatch(/\.hlab b \{[^}]*display: block/);
    expect(css).not.toContain(".weeks");
  });

  it("renders the hatched cap at 3% and omits it under 3% while the label keeps the leftover", () => {
    const resetsAt = "2026-09-10T12:25:00+10:00";
    const sampledAt = "2026-09-10T12:20:00+10:00";
    const { s, claude: atCap } = claudeWith([
      closeRow({ usedPct: 97, leftoverPct: 3, sampledAt, resetsAt }),
    ]);
    const capHtml = render(atCap, s);
    expect(capHtml).toContain('class="hatch"');
    expect(capHtml).toContain("height:3%");
    expect(capHtml).toContain("height:97%");
    const { s: s2, claude: underCap } = claudeWith([
      closeRow({ usedPct: 98, leftoverPct: 2, sampledAt, resetsAt }),
    ]);
    const underHtml = render(underCap, s2);
    expect(underHtml).not.toContain('class="hatch"');
    expect(underHtml).toContain("height:98%");
    expect(underHtml).toContain("2% leftover");
  });

  it("marks estimated closes and leaves on-time closes unmarked", () => {
    const { s, claude } = claudeWith([closeRow({ resetsAtEstimated: true })]);
    expect(render(claude, s)).toContain("12% leftover (est.)");
    const { s: s2, claude: onTime } = claudeWith([
      closeRow({ sampledAt: "2026-09-10T12:20:00+10:00", resetsAt: "2026-09-10T12:25:00+10:00" }),
    ]);
    const html = render(onTime, s2);
    expect(html).not.toContain("read 3d early");
    expect(html).not.toContain("12% leftover (est.)");
    expect(html).not.toContain("last reading");
  });
});

describe("drawer windows", () => {
  // Expected monthly clock from locale parts, so the assertion holds in any
  // timezone without hard-coding one machine's weekday and time.
  const dateClockOf = (iso: string) => clockText(iso)!;
  const render = (json: string, id: string) => {
    const s = JSON.parse(json);
    return renderToString(React.createElement(ProviderDrawer, {
      provider: s.providers.find((p: any) => p.id === id), asOf: s.asOf,
      recommendation: s.recommendation, onClose: () => {},
    })).replace(/<!-- -->/g, "");
  };

  it("renders the badge once, in the header, and none in the Limits section", () => {
    const html = render(monthlyStateSnapshotJson, "opencode-go");
    expect(html.match(/data-testid="pace-badge"/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="pace-badge"')).toBeLessThan(html.indexOf("Close provider details"));
    expect(html.indexOf('data-testid="pace-badge"')).toBeLessThan(html.indexOf("Limits"));
  });

  it("keeps a long provider name and a long badge from crowding the header", () => {
    const s = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const go = s.providers.find((p) => p.id === "opencode-go")!;
    const renamed = { ...go, displayName: "OpenCode Go — Personal Workspace Overflow" };
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: renamed,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('class="who"');
    expect(html).toContain("OpenCode Go — Personal Workspace Overflow");
    // The badge sits top-right on the title row, compact: "Not reporting"
    // alone, with the reason kept out of the header (verdict and Notes
    // carry it). The subtitle reads on its own line under the title.
    expect(html).not.toContain('class="head-badge"');
    expect(html.indexOf('data-testid="pace-badge"')).toBeGreaterThan(html.indexOf('class="sub"'));
    expect(html.indexOf('data-testid="pace-badge"')).toBeLessThan(html.indexOf("drawer-close"));
    const badgeSpan = html.slice(html.indexOf('data-testid="pace-badge"'));
    expect(badgeSpan.slice(0, badgeSpan.indexOf("</span>"))).not.toContain("provider failed");
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.drawer-head \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.drawer-head \.pace \{[^}]*max-width: 100%/);
  });

  it("stacks monthly first inside one Limits section for OpenCode Go", () => {
    const go = render(monthlyStateSnapshotJson, "opencode-go");
    expect(go.match(/<h3>Limits<\/h3>/g)).toHaveLength(1);
    expect(go).toContain("Monthly limit");
    expect(go).toContain("Weekly limit");
    // The quota tag rides the monthly title line; no "Rate limit" text.
    expect(go).toContain("Quota reset");
    expect(go).not.toContain("Rate limit");
    expect(go.match(/quota-tag/g)).toHaveLength(1);
    const w = go.indexOf("<h3>Limits</h3>");
    const m = go.indexOf("Monthly limit");
    const wk = go.indexOf("Weekly limit");
    const f = go.indexOf("5h limit");
    expect(w).toBeGreaterThan(-1);
    // Monthly binds for Go, so it leads; weekly and 5h follow as secondary.
    expect(m).toBeGreaterThan(w);
    expect(wk).toBeGreaterThan(m);
    expect(f).toBeGreaterThan(wk);
    // Every row carries its reset line under the title, and every bar
    // carries the elapsed mark (monthly, weekly, and reported 5h).
    expect(go.match(/class="winrow-sub reset-line"/g)).toHaveLength(3);
    expect(go.match(/class="mark"/g)).toHaveLength(3);
    expect(go).toContain("95% used");
    // The monthly forecast sits on the monthly row inside Limits.
    const goLimits = go.slice(go.indexOf("<h3>Limits</h3>"), go.indexOf("prov-foot"));
    expect(goLimits).toContain("5% of month left");
    // A month-bound bar never hatches weekly-sized waste, and the legend
    // drops the Projected waste entry with it.
    expect(goLimits).not.toContain('data-testid="limit-hatch"');
    expect(goLimits).not.toContain("Projected waste");
    expect(goLimits).toContain("Time elapsed");
    const claudeHtml = render(exampleStateSnapshotJson, "claude");
    expect(claudeHtml).not.toContain("Monthly");
    expect(claudeHtml).not.toContain('data-testid="drawer-monthly"');
  });

  it("names the binding month in the meta line", () => {
    const near = JSON.parse(monthlyStateSnapshotJson).providers[0];
    expect(monthlyMeta(near)).toBe(`Resets ${dateClockOf(near.quota.monthlyResetsAt)} · 5% of month left`);
    const full = JSON.parse(monthlyExhaustedStateSnapshotJson).providers[0];
    expect(monthlyMeta(full)).toBe(`Resets ${dateClockOf(full.quota.monthlyResetsAt)} · weekly leftover unused until then`);
    expect(render(monthlyExhaustedStateSnapshotJson, "opencode-go")).toContain("100%");
  });

  it("shows the calendar date for a monthly reset weeks out, not a bare weekday", () => {
    const s = JSON.parse(monthlyStateSnapshotJson);
    // The live reading behind the report: 26 days out, on a Thursday.
    s.providers[0].quota.monthlyResetsAt = "2026-10-22T13:05:10.000Z";
    const line = monthlyMeta(s.providers[0])!;
    expect(line).toContain(new Date("2026-10-22T13:05:10.000Z").toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    expect(line).toMatch(/· 5% of month left$/);
  });

  it("the verdict explains the badge it shows for a monthly provider", () => {
    const s = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const go = s.providers.find((p) => p.id === "opencode-go")!;
    expect(go.quota?.monthlyPct).toBe(95);
    expect(go.quota?.monthlyStatus).toBe("ok");
    expect(go.advisory?.bindingWindow).toBe("monthly");
    expect(verdictFor(go, Date.parse(s.asOf)).detail).toBe("5% of month left");
    const exhausted = toViewModel(JSON.parse(monthlyExhaustedStateSnapshotJson));
    const goEx = exhausted.providers.find((p) => p.id === "opencode-go")!;
    expect(verdictFor(goEx, Date.parse(exhausted.asOf))).toEqual({
      tone: "neutral",
      label: "• Not ranked",
      detail: "unused until Tue 15 Sep",
    });
  });

  it("computes elapsed shares for the limit bars", () => {
    const asOf = Date.parse("2026-09-06T06:00:00.000Z");
    expect(windowElapsedPct("2026-09-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z", asOf)).toBeCloseTo(52.5, 0);
    expect(windowElapsedPct(null, "2026-09-11T00:00:00.000Z", asOf)).toBeNull();
    expect(windowElapsedPct("2026-09-11T00:00:00.000Z", "2026-09-01T00:00:00.000Z", asOf)).toBeNull();
    // Monthly: start is one calendar month before the reported reset.
    const go = JSON.parse(monthlyStateSnapshotJson).providers[0];
    const monthly = monthlyElapsedPct(go, Date.parse(JSON.parse(monthlyStateSnapshotJson).asOf));
    expect(monthly).not.toBeNull();
    expect(monthly!).toBeGreaterThan(0);
    expect(monthly!).toBeLessThan(100);
    // 5h: derived from the reported reset only; absent reset means no mark.
    const withReset = { quota: { fiveHourResetsAt: new Date(asOf + 2.5 * 3_600_000).toISOString() } };
    expect(fiveHourElapsedPct(withReset as any, asOf)).toBeCloseTo(50, 0);
    expect(fiveHourElapsedPct({ quota: {} } as any, asOf)).toBeNull();
  });

  it("drawerModel copies fiveHourPct and the monthly fields without synthesizing any", () => {
    const m = drawerModel(JSON.parse(monthlyStateSnapshotJson).providers[0]);
    expect(m.fiveHourPct).toBe(12);
    expect(m.fiveHourResetsAt).toBe("2026-09-07T00:30:00.000Z");
    expect(m.monthlyPct).toBe(95);
    const claude = drawerModel(JSON.parse(exampleStateSnapshotJson).providers.find((p: any) => p.id === "claude"));
    expect("monthlyPct" in claude).toBe(false);
  });
});

describe("burn-down pace chart", () => {
  it("projects waste at reset when exhaustion lands after reset", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const geo = burnGeometry(kimi, Date.parse(s.asOf))!;
    expect(geo).not.toBeNull();
    expect(geo.exhaustsBeforeReset).toBe(false);
    expect(geo.projXPct).toBe(100);
    // 22% used + 3.142%/day * 7 days left lands at 44%.
    expect(geo.projYPct).toBeCloseTo(44, 1);
    expect(geo.usedPct).toBe(22);
    expect(geo.elapsedPct).toBeCloseTo(50, 1);
  });

  it("projects exhaustion at 100% before reset when burn outruns the window", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const fast = {
      ...kimi,
      advisory: {
        ...kimi.advisory!,
        burnRate: 20,
        daysToExhaust: 78 / 20,
        status: "at risk" as const,
        urgency: "slow down" as const,
      },
    };
    const geo = burnGeometry(fast as any, Date.parse(s.asOf))!;
    expect(geo.exhaustsBeforeReset).toBe(true);
    expect(geo.projYPct).toBe(100);
    expect(geo.projXPct).toBeGreaterThan(geo.elapsedPct);
    expect(geo.projXPct).toBeLessThan(100);
    // 7 days elapsed + 3.9 days to exhaust over a 14-day window.
    expect(geo.projXPct).toBeCloseTo(((7 + 3.9) / 14) * 100, 1);
  });

  it("renders the Pace section between Windows and History with the shared pace grid", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    ).replace(/<!-- -->/g, "");
    expect(html).toContain('aria-label="Pace"');
    expect(html).toContain('class="burn"');
    expect(html).toContain('class="pacecap"');
    expect(html.indexOf('aria-label="Limits"')).toBeLessThan(html.indexOf('aria-label="Pace"'));
    expect(html.indexOf('aria-label="Pace"')).toBeLessThan(html.indexOf("prov-foot"));
    expect(html).toMatch(/Burn-down: 22 percent used at 50 percent elapsed/);
    expect(html).toContain("forecast lands at 44 percent");
    // The four-cell grid matches the card: labels and values in cells.
    expect(html).toContain('class="pstats"');
    expect(html).toContain("Avg pace");
    expect(html).toContain("24h pace");
    expect(html).toContain("Ideal pace");
    expect(html).toContain("Resets in");
    expect(html).toContain("3.1%/day");
    expect(html).toContain("7d 0h");
    // Axis titles, legend note, and elapsed readout on the now-line.
    expect(html).toContain("Quota used (%)");
    expect(html).toContain("Time elapsed in window (%)");
    expect(html).toContain("Dot is now");
    expect(html).toContain("Dashed is forecast");
    expect(html).toContain("Weekly quota window");
    expect(html).toContain("now · 50% elapsed");
    expect(html).toContain("start · 0%");
    expect(html).toContain("quota reset · 100%");
    expect(html).toContain("hollow");
    // Basis line keeps the pace wording under the grid.
    expect(html).toMatch(/averaged over|Window avg|Measured/);
  });

  it("omits the hollow forecast ring when already at 100% used so the now dot stays solid", () => {
    const s = toViewModel(JSON.parse(monthlyExhaustedStateSnapshotJson));
    const go = s.providers.find((p) => p.id === "opencode-go")!;
    const html = renderToString(
      React.createElement(BurnDown, { provider: go, asOf: s.asOf }),
    );
    expect(html).toContain('class="dot cap"');
    expect(html).not.toContain("hollow");
  });

  it("locks the burn slope, dot, and basis line to the time quota exhausted", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const muse = s.providers.find((p) => p.id === "kimi")!;
    // Window: 2026-08-28 to 2026-09-04 (7 days = 168h)
    // asOf: 2026-08-31T06:00:00Z (72h in = 42.86% elapsed)
    // exhaustedAt: 2026-08-29T00:00:00Z (24h in = 14.29% elapsed)
    const exhaustedMuse = {
      ...muse,
      id: "muse",
      displayName: "Muse",
      quota: {
        ...muse.quota!,
        provider: "muse",
        weeklyPct: 100,
        periodStart: "2026-08-28T00:00:00.000Z",
        resetsAt: "2026-09-04T00:00:00.000Z",
      },
      advisory: {
        ...muse.advisory!,
        provider: "muse",
        remaining: 0,
        bindingRemaining: 0,
        daysToExhaust: 0,
        avgPace: 100,
        burnRate: 100,
        exhaustedAt: "2026-08-29T00:00:00.000Z",
      },
    };

    const asOfMs = Date.parse("2026-08-31T00:00:00.000Z"); // 3.0 days elapsed (42.86%)
    const geo = burnGeometry(exhaustedMuse as any, asOfMs)!;
    expect(geo).not.toBeNull();
    expect(geo.usedPct).toBe(100);
    expect(geo.elapsedPct).toBeCloseTo(42.86, 1);
    expect(geo.exhaustedElapsedPct).toBeCloseTo(14.29, 1);

    const html = renderToString(
      React.createElement(BurnDown, { provider: exhaustedMuse as any, asOf: "2026-08-31T00:00:00.000Z" }),
    );
    // Dot is placed at 14.29% elapsed, not 42.86%
    // PLOT.left = 48, PLOT.right = 388, width = 340
    // sx(14.2857) = 48 + 0.142857 * 340 = 96.6
    expect(html).toContain('cx="96.6" cy="28"');
    // Slope line ends at (96.6, 28)
    expect(html).toContain('x2="96.6" y2="28" class="actual cap" data-testid="burn-actual"');
    // Plateau line connects 96.6 to nowX (48 + 0.42857 * 340 = 193.7)
    expect(html).toContain('x1="96.6" y1="28" x2="193.7" y2="28" class="actual cap" data-testid="burn-exhausted-plateau"');
    // Forecast line extends from nowX (193.7) to reset (388)
    expect(html).toContain('x1="193.7" y1="28" x2="388" y2="28" class="proj cap" data-testid="burn-proj"');
    // Legend and basis
    expect(html).toContain("Dot is quota exhausted");
    expect(html).toContain("averaged over 1.0 days to reach 100%");
    expect(html).toContain("Burn-down: 100 percent used at 14 percent elapsed, currently 43 percent elapsed");
  });

  it("plots the monthly quota window for monthly-bound OpenCode Go", () => {
    const s = toViewModel(JSON.parse(monthlyStateSnapshotJson));
    const go = s.providers.find((p) => p.id === "opencode-go")!;
    const geo = burnGeometry(go, Date.parse(s.asOf))!;
    expect(geo).not.toBeNull();
    expect(geo.usedPct).toBe(95);
    expect(geo.elapsedPct).toBeCloseTo(72, 0);
    expect(geo.exhaustsBeforeReset).toBe(true);

    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: go,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Monthly quota window");
    expect(html).toContain("now · 72% elapsed");
    expect(html).toContain("8d 16h");
    expect(html).toContain("averaged over 22.3 days of this window");
  });

  it("paints cap and ontrack tones with the mock classes plus ahead token", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const behindHtml = renderToString(
      React.createElement(BurnDown, { provider: kimi, asOf: s.asOf })
    );
    expect(behindHtml).toContain('class="burn"');
    expect(behindHtml).toMatch(/actual (behind|ontrack)/);
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.burn \{[^}]*width: 100%/);
    expect(css).toMatch(/\.burn \.actual\.cap \{[^}]*stroke: var\(--danger\)/);
    expect(css).toMatch(/\.burn \.actual\.behind \{[^}]*stroke: var\(--warn\)/);
    expect(css).toMatch(/\.burn \.actual\.ontrack \{[^}]*stroke: var\(--ahead\)/);
    expect(css).toMatch(/\.pacecap \.basis \{[^}]*display: block/);
    expect(css).toMatch(/\.pstats \{[^}]*grid-template-columns: repeat\(4, 1fr\)/);
  });

  it("omits the entire Pace section when pace is unknown or the provider is excluded", () => {
    const unknown = toViewModel(JSON.parse(unknownPaceStateSnapshotJson));
    const unknownKimi = unknown.providers.find((p) => p.id === "kimi")!;
    expect(burnGeometry(unknownKimi, Date.parse(unknown.asOf))).toBeNull();
    const unknownHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: unknownKimi,
        asOf: unknown.asOf,
        recommendation: unknown.recommendation,
        onClose: () => {},
      })
    );
    expect(unknownHtml).not.toContain('aria-label="Pace"');
    expect(unknownHtml).not.toContain('class="burn"');

    const stale = toViewModel(JSON.parse(staleStateSnapshotJson));
    const staleKimi = stale.providers.find((p) => p.id === "kimi")!;
    expect(staleKimi.exclusionReason).toBe("stale");
    expect(burnGeometry(staleKimi, Date.parse(stale.asOf))).toBeNull();
    const staleHtml = renderToString(
      React.createElement(ProviderDrawer, {
        provider: staleKimi,
        asOf: stale.asOf,
        recommendation: stale.recommendation,
        onClose: () => {},
      })
    );
    expect(staleHtml).not.toContain('aria-label="Pace"');

    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const noBurn = {
      ...kimi,
      advisory: { ...kimi.advisory!, burnRate: null, paceSource: "window-average" as const },
    };
    expect(burnGeometry(noBurn as any, Date.parse(s.asOf))).toBeNull();
    const noElapsed = {
      ...kimi,
      quota: { ...kimi.quota!, periodStart: "not-a-date", resetsAt: "also-bad" },
    };
    expect(burnGeometry(noElapsed as any, Date.parse(s.asOf))).toBeNull();
    expect(
      renderToString(React.createElement(BurnDown, { provider: unknownKimi, asOf: unknown.asOf }))
    ).toBe("");
  });
});

