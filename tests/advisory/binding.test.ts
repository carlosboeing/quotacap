import { describe, it, expect } from "vitest";
import { computeAdvisory } from "../../src/advisory/engine.js";
import type { Quota } from "../../src/adapters/types.js";

const DAY_MS = 86400000;
const NOW = new Date("2026-09-15T12:00:00Z");

function goQuota(weeklyPct: number, weeklyDaysLeft: number, monthly?: { pct: number; daysLeft: number; status?: "ok" | "exhausted" }): Quota {
  const resets = NOW.getTime() + weeklyDaysLeft * DAY_MS;
  return {
    provider: "opencode-go", plan: "unknown", weeklyPct,
    resetsAt: new Date(resets).toISOString(),
    periodStart: new Date(resets - 7 * DAY_MS).toISOString(),
    source: "api", fetchedAt: NOW.toISOString(),
    ...(monthly ? {
      monthlyKind: "included" as const, monthlyPct: monthly.pct, monthlyStatus: monthly.status ?? "ok",
      monthlyResetsAt: new Date(NOW.getTime() + monthly.daysLeft * DAY_MS).toISOString(),
    } : {}),
  };
}

describe("binding window", () => {
  it("95% monthly over 7 days beside 0% weekly over 6 days binds monthly", () => {
    const a = computeAdvisory(goQuota(0, 6, { pct: 95, daysLeft: 7 }), 1, 1, NOW);
    expect(a.bindingWindow).toBe("monthly");
    expect(a.bindingRemaining).toBe(5);
    expect(a.bindingDaysLeft).toBeCloseTo(7, 9);
    expect(a.remaining).toBe(100); // weekly story unchanged
  });

  it("weekly 90% used with 1 day left beside monthly 50% used over 4 days binds weekly", () => {
    // 10/day weekly against 12.5/day monthly. The design's 20-day example binds
    // monthly under its own formula (2.5/day) and is corrected here.
    const a = computeAdvisory(goQuota(90, 1, { pct: 50, daysLeft: 4 }), 1, 1, NOW);
    expect(a.bindingWindow).toBe("weekly");
    expect(a.bindingRemaining).toBe(a.remaining);
  });

  it("exhausted status at percent 40 still binds monthly with remaining 0", () => {
    const a = computeAdvisory(goQuota(10, 6, { pct: 40, daysLeft: 10, status: "exhausted" }), 1, 1, NOW);
    expect(a.bindingWindow).toBe("monthly");
    expect(a.bindingRemaining).toBe(0);
  });

  it("both windows empty binds monthly", () => {
    const a = computeAdvisory(goQuota(100, 3, { pct: 100, daysLeft: 5, status: "exhausted" }), 1, 1, NOW);
    expect(a.bindingWindow).toBe("monthly");
    expect(a.bindingRemaining).toBe(0);
  });

  it("an exhausted week with leftover month binds weekly", () => {
    const a = computeAdvisory(goQuota(100, 3, { pct: 40, daysLeft: 20 }), 1, 1, NOW);
    expect(a.bindingWindow).toBe("weekly");
  });

  it("no monthlyKind reports weekly with the weekly numbers", () => {
    const a = computeAdvisory(goQuota(30, 4), 2, 2, NOW);
    expect(a.bindingWindow).toBe("weekly");
    expect(a.bindingRemaining).toBe(a.remaining);
    expect(a.bindingDaysLeft).toBe(a.daysLeft);
  });

  it("sets the three fields on all three return paths", () => {
    const monthly = { pct: 95, daysLeft: 7 };
    const unknownPace = computeAdvisory(goQuota(0, 6, monthly), null, null, NOW);
    expect(unknownPace.burnRate).toBeNull();
    const weeklyExhausted = computeAdvisory(goQuota(100, 6, { pct: 99, daysLeft: 7 }), 1, 1, NOW);
    expect(weeklyExhausted.remaining).toBe(0);
    const measured = computeAdvisory(goQuota(20, 6, monthly), 1, 1, NOW);
    for (const a of [unknownPace, measured]) {
      expect(a.bindingWindow).toBe("monthly");
      expect(a.bindingRemaining).toBe(5);
    }
    expect(weeklyExhausted.bindingWindow).toBe("weekly");
    expect(weeklyExhausted.bindingRemaining).toBe(0);
  });
});
