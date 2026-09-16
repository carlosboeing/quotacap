import fs from "node:fs";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { exampleStateSnapshotJson, unknownPaceStateSnapshotJson } from "../fixtures/stable-state.js";
import { providerSubtitle, toViewModel } from "../../web/src/state.js";
import {
  compactSnapshot,
  drawerModel,
  paceBasis,
  rankingCopy,
  sourceLabel,
} from "../../web/src/components/ProviderDrawer.js";
import {
  ProviderDrawer,
  submitProviderRename,
} from "../../web/src/components/ProviderDrawer.js";
import { closeDateLabel, closeResetStamp, closeSampleStamp } from "../../web/src/components/ClosedWeeks.js";
import { renameProvider } from "../../web/src/api.js";

describe("provider drawer", () => {
  it("exposes server fields without synthesis", () => {
    const s = JSON.parse(exampleStateSnapshotJson);
    const m = drawerModel(s.providers.find((p: any) => p.id === "codex"));
    expect(m.estimatedReset).toBe(true);
    expect(m.evidence).toContain("estimated-reset");
    expect(m.sessionReset).toBeUndefined(); // never synthesized
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
  it("labels adapter source without inventing credential paths", () => {
    expect(sourceLabel("cli")).toBe("Live CLI");
    expect(sourceLabel("tui")).toBe("Live TUI");
    expect(sourceLabel("manual")).toBe("Manual ingest");
  });
  it("renders the concept drawer sections from snapshot fields", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    expect(paceBasis(kimi, Date.parse(s.asOf))).toMatch(/averaged over|Window avg|Measured/);
    const why = rankingCopy(kimi, s.recommendation);
    expect(why.known).toMatch(/Kimi reports 22%/);
    expect(why.pace).toMatch(/%\/day/);
    const html = renderToString(
      React.createElement(ProviderDrawer, {
        provider: kimi,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(html).toContain("Weekly limit");
    expect(html).toContain("Adapter and provenance");
    expect(html).toContain("Ranking rationale");
    expect(html).toMatch(/averaged over|Window avg|Measured/);
    expect(html).toContain("Live CLI");
    expect(html).toContain("Credential");
    expect(html).toContain("handled by Kimi");
    expect(html).not.toContain("kimi-code.json");
    expect(html).not.toContain("Burn rate");
    const snap = compactSnapshot(kimi, Date.parse(s.asOf));
    expect(snap.provider).toBe("kimi");
    expect(snap.source).toBe("cli");
    expect(snap.pacingStatus).toMatch(/behind|ontrack|ahead|cap|out/);
  });
  it("displays the 5h Limit section in the drawer", () => {
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
    expect(html).toContain("Weekly limit");
    expect(html).toContain("5h Limit");
    expect(html.replace(/<!-- -->/g, "")).toContain("22% used");
  });
  it("renders 5h Limit even when 0% used, and omits it when provider reports no short window", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const zeroSession = {
      ...s.providers.find((p) => p.id === "claude")!,
      quota: { ...s.providers.find((p) => p.id === "claude")!.quota!, sessionPct: 0 },
    };
    const htmlZero = renderToString(
      React.createElement(ProviderDrawer, {
        provider: zeroSession,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(htmlZero).toContain("5h Limit");
    expect(htmlZero.replace(/<!-- -->/g, "")).toContain("0% used");

    const grok = s.providers.find((p) => p.id === "grok")!;
    const htmlGrok = renderToString(
      React.createElement(ProviderDrawer, {
        provider: grok,
        asOf: s.asOf,
        recommendation: s.recommendation,
        onClose: () => {},
      })
    );
    expect(htmlGrok).not.toContain("5h Limit");
  });
  it("explains both paces against the target in ranking rationale", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const flat = {
      ...kimi,
      advisory: { ...kimi.advisory!, burnRate: 0, recentRate: 0, avgPace: 10.6, paceSource: "recent", status: "on track" },
    };
    expect(rankingCopy(flat as any, s.recommendation).pace).toBe(
      "10.6%/day window average and 0.0%/day over the last 24h. The ideal pace to finish is 11.1%/day."
    );
    const risky = {
      ...kimi,
      advisory: { ...kimi.advisory!, burnRate: 24, recentRate: 24, avgPace: 10.6, paceSource: "recent", status: "at risk" },
    };
    expect(rankingCopy(risky as any, s.recommendation).pace).toBe(
      "10.6%/day window average and 24.0%/day over the last 24h, against an ideal pace of 11.1%/day."
    );
  });
  it("names Watch rows as near the cap instead of on-track or save copy", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const watchOnTrack = {
      ...kimi,
      advisory: { ...kimi.advisory!, status: "watch", urgency: "on track" },
    };
    const why = rankingCopy(watchOnTrack as any, null);
    expect(why.decision).toBe("Near the cap — position or reset clock uncertain.");
    expect(why.decision).not.toMatch(/Pace matches the window|Unused quota/);
    // A Watch row carrying save urgency used to fall through to the unused-quota copy.
    const watchSave = { ...watchOnTrack, advisory: { ...watchOnTrack.advisory, urgency: "save" } };
    expect(rankingCopy(watchSave as any, null).decision).toBe(
      "Near the cap — position or reset clock uncertain."
    );
  });
  it("names exhausted windows in ranking rationale", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const capped = {
      ...kimi,
      quota: { ...kimi.quota!, usedPct: 100 },
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
    expect(rankingCopy(capped as any, s.recommendation).pace).toMatch(/^Exhausted at 100% used\. Resets /);
  });
  it("matches concept JSON snapshot type and does not clip the block", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.draw-code \{[^}]*font-size: var\(--t-2\)/);
    expect(css).toMatch(/\.draw-code \{[^}]*line-height: 1\.6/);
    expect(css).toMatch(/\.draw-code \{[^}]*white-space: pre;/);
    expect(css).not.toMatch(/\.draw-code \{[^}]*max-height:/);
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
    expect(html).toContain("title=\"Click to rename\"");
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

  it("renders Closed weeks after the live 5h window, with dated cells", () => {
    const { s, claude } = claudeWith([closeRow()]);
    const html = render(claude, s);
    expect(html).toContain("Closed weeks");
    expect(html.indexOf("Weekly limit")).toBeLessThan(html.indexOf("Closed weeks"));
    expect(html.indexOf("5h Limit")).toBeLessThan(html.indexOf("Closed weeks"));
    expect(html).toContain(label("2026-09-10T12:25:00+10:00"));
    expect(html).toContain("12% leftover");
    expect(html).toContain(`88% used, 12% leftover, reset ${closeResetStamp("2026-09-10T12:25:00+10:00")}`);
    const weeks = html.slice(html.indexOf("Closed weeks"), html.indexOf("Adapter and provenance"));
    expect(weeks).not.toMatch(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}/);
  });

  it("omits Closed weeks when there is no close", () => {
    const { s, claude } = claudeWith([]);
    const html = render(claude, s);
    expect(html).not.toContain("Closed weeks");
  });

  it("orders cells oldest left and newest right", () => {
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

  it("names an early reading on its cell and under the strip", () => {
    const { s, claude } = claudeWith([closeRow()]);
    const html = render(claude, s);
    expect(html).toContain("read 3d early");
    expect(html).toContain(closeSampleStamp("2026-09-07T09:04:00+10:00")!);
    expect(html).toContain("3 days before that reset");
    expect(html).toContain(`${label("2026-09-10T12:25:00+10:00")} leftover is from the`);
  });

  it("reads a one-hour-early sample in singular words on both lines", () => {
    const resetsAt = "2026-09-10T12:25:00+10:00";
    const sampledAt = new Date(Date.parse(resetsAt) - 60 * 60_000).toISOString();
    const { s, claude } = claudeWith([closeRow({ sampledAt, resetsAt })]);
    const html = render(claude, s);
    expect(html).toContain("read 1h early");
    expect(html).toContain("1 hour before that reset");
    expect(html).not.toContain("1 hours");
  });

  it("floors the cell and the strip note the same way", () => {
    const resetsAt = "2026-09-10T12:25:00+10:00";
    const sampledAt = new Date(Date.parse(resetsAt) - 90 * 60_000).toISOString();
    const { s, claude } = claudeWith([closeRow({ sampledAt, resetsAt })]);
    const html = render(claude, s);
    expect(html).toContain("read 1h early");
    expect(html).toContain("1 hour before that reset");
    expect(html).not.toContain("2 hours");
  });

  it("spaces every stale note under the strip", () => {
    const css = fs.readFileSync("web/src/theme.css", "utf8");
    expect(css).toMatch(/\.weeks ~ \.cell-s \{[^}]*margin-top: var\(--s2\)/);
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
  });
});

