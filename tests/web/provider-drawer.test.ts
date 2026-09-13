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
    expect(html).toContain("Current window");
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
  it("explains both paces against the target in ranking rationale", () => {
    const s = toViewModel(JSON.parse(exampleStateSnapshotJson));
    const kimi = s.providers.find((p) => p.id === "kimi")!;
    const flat = {
      ...kimi,
      advisory: { ...kimi.advisory!, burnRate: 0, avgPace: 10.6, paceSource: "recent", status: "on track" },
    };
    expect(rankingCopy(flat as any, s.recommendation).pace).toBe(
      "10.6%/day window average and 0.0%/day over the last 24h. Finishing on pace needs 11.1%/day."
    );
    const risky = {
      ...kimi,
      advisory: { ...kimi.advisory!, burnRate: 24, avgPace: 10.6, paceSource: "recent", status: "at risk" },
    };
    expect(rankingCopy(risky as any, s.recommendation).pace).toBe(
      "10.6%/day window average and 24.0%/day over the last 24h, against a 11.1%/day target to finish on pace."
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

