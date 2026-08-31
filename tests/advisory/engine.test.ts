import { describe, it, expect } from "vitest";
import { recommend, computeAdvisory, averagePace } from "../../src/advisory/engine.js";
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

  it("derives pace from one reading: 60% over 3 days is 20%/day", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00" } as any;
    expect(averagePace(q, now)).toBeCloseTo(20, 5);
  });

  it("returns no pace when the window start is unknown", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    expect(averagePace({ provider:"kimi", usedPct:60 } as any, now)).toBeNull();
    expect(averagePace({ provider:"kimi", usedPct:60, periodStart:"nonsense" } as any, now)).toBeNull();
  });

  it("uses the average when no history exists, never a constant", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map(), now);
    const adv = rec.advisories[0];
    expect(adv.burnMeasured).toBe(false);
    expect(adv.burnRate).toBeCloseTo(20, 5);
    // ideal is (100-60)/4 = 10%/day, so burning 20%/day exhausts early
    expect(adv.idealRate).toBeCloseTo(10, 5);
    expect(adv.status).toBe("at risk");
  });

  it("prefers measured recent pace over the average", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map([["kimi", 3]]), now);
    expect(rec.advisories[0].burnRate).toBe(3);
    expect(rec.advisories[0].burnMeasured).toBe(true);
  });

  it("waste follows the real pace, not a constant", () => {
    // 3% used over 1 day is 3%/day. The old code assumed 2%/day for every
    // provider it had no history for, so the waste it reported was invented.
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"codex", usedPct:3, periodStart:"2026-08-30T06:00:00+10:00",
                resetsAt:"2026-09-05T06:00:00+10:00" } as any;
    const adv = recommend([q], "any", new Map(), now).advisories[0];
    expect(adv.burnRate).toBeCloseTo(3, 5);
    expect(Math.round(adv.wastePct)).toBe(82);  // 97 - 3*5; the constant gave 87
  });
});
