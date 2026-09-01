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
    expect(Math.round(adv.wastePct!)).toBe(82);  // 97 - 3*5; the constant gave 87
  });

  it("treats pace as unknown when window is under 1 hour and has no history", () => {
    // 1% used after 30 minutes with no history
    const now = new Date("2026-08-28T06:30:00+10:00");
    const q = {
      provider: "kimi",
      usedPct: 1,
      periodStart: "2026-08-28T06:00:00+10:00",
      resetsAt: "2026-09-04T06:00:00+10:00",
    } as any;
    const rec = recommend([q], "any", new Map(), now);
    const adv = rec.advisories[0];
    expect(adv.burnRate).toBeNull();
    expect(adv.burnMeasured).toBe(false);
    expect(adv.paceSource).toBe("unknown");
    expect(adv.wastePct).toBeNull();
    expect(adv.daysToExhaust).toBeNull();
    expect(adv.status).toBe("unknown");
    expect(rec.use).toBe("kimi");
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.reason).toMatch(/Measuring pace; 99% remains with 7\.0d until reset/);
  });

  it("prefers measured positive waste over unknown providers", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const freshKimi = {
      provider: "kimi",
      usedPct: 1,
      periodStart: "2026-08-31T05:30:00+10:00", // 30 min in
      resetsAt: "2026-09-04T06:00:00+10:00",
    } as any;
    const measuredClaude = {
      provider: "claude",
      usedPct: 10,
      periodStart: "2026-08-28T06:00:00+10:00", // 3 days in, 10/3 = 3.33%/day
      resetsAt: "2026-09-04T06:00:00+10:00", // 4 days left, waste = 90 - 3.33*4 = 76.67%
    } as any;
    const rec = recommend([freshKimi, measuredClaude], "any", new Map(), now);
    expect(rec.use).toBe("claude");
    expect(rec.recommendationBasis).toBe("measured-waste");
    expect(rec.reason).toMatch(/77% waste in 4\.0d/);
    expect(rec.advisories.find(a => a.provider === "kimi")?.paceSource).toBe("unknown");
    expect(rec.advisories.find(a => a.provider === "claude")?.paceSource).toBe("window-average");
  });

  it("recommends unknown provider headroom when measured provider is at risk of exhausting", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const atRiskClaude = {
      provider: "claude",
      usedPct: 80,
      periodStart: "2026-08-28T06:00:00+10:00", // 3 days in
      resetsAt: "2026-09-04T06:00:00+10:00", // 4 days left
    } as any;
    // measured burn: 25%/day -> exhausts 20% in 0.8 days (< 4 days) -> at risk, wastePct = 0
    const freshKimi = {
      provider: "kimi",
      usedPct: 2,
      periodStart: "2026-08-31T05:30:00+10:00", // 30 min in (<1h, unknown)
      resetsAt: "2026-09-02T06:00:00+10:00", // 2 days left -> 98% / 2d = 49%/day headroom
    } as any;
    const rec = recommend([atRiskClaude, freshKimi], "any", new Map([["claude", 25]]), now);
    expect(rec.use).toBe("kimi");
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.reason).toMatch(/Measuring pace; 98% remains with 2\.0d until reset/);
    const claudeAdv = rec.advisories.find(a => a.provider === "claude");
    expect(claudeAdv?.status).toBe("at risk");
    expect(claudeAdv?.wastePct).toBe(0);
    const kimiAdv = rec.advisories.find(a => a.provider === "kimi");
    expect(kimiAdv?.status).toBe("unknown");
    expect(kimiAdv?.burnRate).toBeNull();
  });

  it("falls back to unknown provider with highest headroom when only unknown providers exist", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const freshKimi = {
      provider: "kimi",
      usedPct: 10, // 90% left, 3 days left -> 30%/day
      periodStart: "2026-08-31T05:30:00+10:00",
      resetsAt: "2026-09-03T06:00:00+10:00",
    } as any;
    const freshClaude = {
      provider: "claude",
      usedPct: 20, // 80% left, 4 days left -> 20%/day
      periodStart: "2026-08-31T05:30:00+10:00",
      resetsAt: "2026-09-04T06:00:00+10:00",
    } as any;
    const rec = recommend([freshClaude, freshKimi], "any", new Map(), now);
    expect(rec.use).toBe("kimi");
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.reason).toMatch(/Measuring pace; 90% remains with 3\.0d until reset/);
  });

  it("retains all providers in advisories and alternatives output", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q1 = { provider: "kimi", usedPct: 1, periodStart: "2026-08-31T05:30:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const q2 = { provider: "claude", usedPct: 80, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const q3 = { provider: "codex", usedPct: 10, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q1, q2, q3], "any", new Map([["claude", 25]]), now);
    expect(rec.advisories.map(a => a.provider)).toEqual(["kimi", "claude", "codex"]);
    expect(rec.alternatives.map(a => a.provider)).toEqual(["kimi", "claude", "codex"]);
  });

  it("leaves normal measured recommendations unchanged", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"codex", usedPct:3, periodStart:"2026-08-30T06:00:00+10:00", resetsAt:"2026-09-05T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map(), now);
    expect(rec.use).toBe("codex");
    expect(rec.recommendationBasis).toBe("measured-waste");
    expect(rec.advisories[0].burnRate).toBeCloseTo(3, 5);
    expect(Math.round(rec.advisories[0].wastePct!)).toBe(82);
  });

  it("returns no recommendation when all quotas are at risk and no unknown headroom exists", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const atRisk1 = { provider: "claude", usedPct: 80, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const atRisk2 = { provider: "kimi", usedPct: 90, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([atRisk1, atRisk2], "any", new Map([["claude", 25], ["kimi", 30]]), now);
    expect(rec.use).toBe("none");
    expect(rec.recommendationBasis).toBe("none");
    expect(rec.reason).toBe("all quotas at risk or exhausted");
  });
});
