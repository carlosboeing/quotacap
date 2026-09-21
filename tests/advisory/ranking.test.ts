import { describe, it, expect } from "vitest";
import { recommend, computeAdvisory } from "../../src/advisory/engine.js";
import type { Quota } from "../../src/adapters/types.js";

const DAY_MS = 86400000;
const NOW = new Date("2026-09-15T12:00:00Z");

function q(provider: string, weeklyPct: number, weeklyDaysLeft: number, monthly?: { pct: number; daysLeft: number; status?: "ok" | "exhausted" }): Quota {
  const resets = NOW.getTime() + weeklyDaysLeft * DAY_MS;
  return {
    provider, plan: "p", weeklyPct,
    resetsAt: new Date(resets).toISOString(),
    periodStart: new Date(resets - 7 * DAY_MS).toISOString(),
    source: "api", fetchedAt: NOW.toISOString(),
    ...(monthly ? {
      monthlyKind: "included" as const, monthlyPct: monthly.pct, monthlyStatus: monthly.status ?? "ok",
      monthlyResetsAt: new Date(NOW.getTime() + monthly.daysLeft * DAY_MS).toISOString(),
    } : {}),
  };
}
const flat = { recent: 0, baseline: 0 };
// kimi: 60 left over 6 days at 8/day → wastePct exactly 12.
const kimi = q("kimi", 40, 6);
const kimiPace: [string, { recent: number; baseline: number }] = ["kimi", { recent: 8, baseline: 8 }];

describe("rankWaste", () => {
  it("a monthly-bound pick reports rankWaste, bindingWindow and the month reason", () => {
    const rec = recommend([q("opencode-go", 0, 6, { pct: 95, daysLeft: 7 })], "any", new Map([["opencode-go", flat]]), NOW);
    expect(rec.use).toBe("opencode-go");
    expect(rec.wastePct).toBeCloseTo(5 * 6 / 7, 9); // 4.3
    expect(rec.bindingWindow).toBe("monthly");
    expect(rec.reason).toBe("5% of month left in 7.0d");
  });

  it("95% monthly over 7 days loses to a peer at 12% weekly waste", () => {
    const rec = recommend([q("opencode-go", 0, 6, { pct: 95, daysLeft: 7 }), kimi], "any",
      new Map([["opencode-go", flat], kimiPace]), NOW);
    expect(rec.use).toBe("kimi");
  });

  it("80% monthly over 20 days scores 6.0 and loses to the same peer", () => {
    const go = q("opencode-go", 0, 6, { pct: 80, daysLeft: 20 });
    expect(recommend([go], "any", new Map([["opencode-go", flat]]), NOW).wastePct).toBeCloseTo(6, 9);
    expect(recommend([go, kimi], "any", new Map([["opencode-go", flat], kimiPace]), NOW).use).toBe("kimi");
  });

  it("50% monthly over 15 days scores 20 and is not suppressed", () => {
    const go = q("opencode-go", 0, 6, { pct: 50, daysLeft: 15 });
    expect(recommend([go], "any", new Map([["opencode-go", flat]]), NOW).wastePct).toBeCloseTo(20, 9);
    expect(recommend([go, kimi], "any", new Map([["opencode-go", flat], kimiPace]), NOW).use).toBe("opencode-go");
  });

  it("a weekly-bound pick's rankWaste equals its wastePct exactly", () => {
    const rec = recommend([kimi], "any", new Map([kimiPace]), NOW);
    const adv = computeAdvisory(kimi, 8, 8, NOW);
    expect(rec.wastePct).toBe(adv.wastePct);
    expect(rec.bindingWindow).toBe("weekly");
    expect(rec.reason).toBe("12% waste in 6.0d");
  });

  it("100% monthly is absent from both pools", () => {
    const exhausted = q("opencode-go", 0, 6, { pct: 100, daysLeft: 7, status: "exhausted" });
    expect(recommend([exhausted], "any", new Map([["opencode-go", flat]]), NOW).use).toBe("none");
    expect(recommend([exhausted], "any", new Map(), NOW).use).toBe("none");
  });

  it("weekly burn-now urgency does not promote a monthly-bound provider", () => {
    // 2 weekly days left and 100% waste → burn now; monthly 50 over 20 days binds, rankWaste 5.
    const go = q("opencode-go", 0, 2, { pct: 50, daysLeft: 20 });
    expect(computeAdvisory(go, 0, 0, NOW).urgency).toBe("burn now");
    expect(recommend([go, kimi], "any", new Map([["opencode-go", flat], kimiPace]), NOW).use).toBe("kimi");
  });

  it("pool 2 ranks on binding headroom and words the month", () => {
    const rec = recommend([q("opencode-go", 0, 6, { pct: 95, daysLeft: 7 })], "any", new Map(), NOW);
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.wastePct).toBeNull();
    expect(rec.bindingWindow).toBe("monthly");
    expect(rec.reason).toBe("Measuring pace; 5% of month left with 7.0d until reset");
  });

  it("weekly pool-2 wording is unchanged", () => {
    const rec = recommend([q("kimi", 47, 5.2)], "any", new Map(), NOW);
    expect(rec.reason).toBe("Measuring pace; 53% remains with 5.2d until reset");
    expect(rec.bindingWindow).toBe("weekly");
  });
});
