import { describe, it, expect } from "vitest";
import {
  exampleStateSnapshotJson,
  staleStateSnapshotJson,
  resetPassedStateSnapshotJson,
  unknownPaceStateSnapshotJson,
} from "../fixtures/stable-state.js";
import { hatchGradient, paceBadge, resetClock } from "../../web/src/components/PaceBar.js";
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
    expect(paceBadge(byId.get("agy"))).toBe("On track"); // unknown pace, urgency on track
    expect(paceBadge(byId.get("manual"))).toBe("Not reporting");
    const u = JSON.parse(unknownPaceStateSnapshotJson);
    expect(paceBadge(u.providers.find((p: any) => p.id === "kimi"))).toBe("On track");
    // No fixture carries at-risk or slow-down advisories; map them synthetically.
    expect(paceBadge({ exclusionReason: null, advisory: { status: "at risk", urgency: "on track" } } as any)).toBe(
      "Cap risk"
    );
    expect(paceBadge({ exclusionReason: null, advisory: { status: "on track", urgency: "slow down" } } as any)).toBe(
      "Ahead of pace"
    );
  });
});

describe("reset clock", () => {
  it("formats weekday and 24h time with a space, not a middot", () => {
    expect(resetClock("2026-09-10T21:00:00+10:00")).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/);
    expect(resetClock("2026-09-10T21:00:00+10:00")).not.toContain("·");
    expect(resetClock("not-a-date")).toBeNull();
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
