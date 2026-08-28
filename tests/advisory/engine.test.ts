import { describe, it, expect } from "vitest";
import { recommend, computeAdvisory } from "../../src/advisory/engine.js";
describe("advisory", () => {
  it("computes ideal and waste", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:22, resetsAt:"2026-08-29T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 6, now);
    expect(adv.wastePct).toBeGreaterThan(0);
    expect(adv.urgency).toBe("burn now");
  });

  it("flags at risk when measured burn exhausts the quota before reset", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:16, resetsAt:"2026-08-31T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 40, now, true);
    expect(adv.burnMeasured).toBe(true);
    expect(adv.burnRate).toBe(40);
    expect(adv.daysToExhaust).toBeCloseTo(2.1, 1);
    expect(adv.status).toBe("at risk");
  });

  it("marks on track when burn stays under the ideal rate", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:16, resetsAt:"2026-08-31T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 20, now, true);
    expect(adv.daysToExhaust).toBeCloseTo(4.2, 1);
    expect(adv.status).toBe("on track");
  });

  it("reports unmeasured burn as a default", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:16, resetsAt:"2026-08-31T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 2, now, false);
    expect(adv.burnMeasured).toBe(false);
    expect(adv.burnRate).toBe(2);
  });
});
