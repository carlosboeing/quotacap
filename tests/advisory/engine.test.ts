import { describe, it, expect } from "vitest";
import { recommend, computeAdvisory, averagePace } from "../../src/advisory/engine.js";
import type { Quota } from "../../src/adapters/types.js";

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const BOARD_NOW = new Date("2026-09-16T06:00:00+10:00");

// A weekly window whose elapsed fraction is `elapsedPct` at BOARD_NOW, so the
// 16 Sept board cases keep their real position-in-window while the forecast
// inputs stay explicit. `over` carries extras such as resetsAtEstimated.
function boardQuota(provider: string, usedPct: number, elapsedPct: number, over: Record<string, unknown> = {}): Quota {
  const start = BOARD_NOW.getTime() - (WEEK_MS * elapsedPct) / 100;
  return {
    provider,
    plan: "p",
    usedPct,
    periodStart: new Date(start).toISOString(),
    resetsAt: new Date(start + WEEK_MS).toISOString(),
    source: "cli",
    fetchedAt: BOARD_NOW.toISOString(),
    ...over,
  } as Quota;
}

function boardAdv(q: Quota, recent: number | null, baseline: number | null) {
  return computeAdvisory(q, recent, baseline, BOARD_NOW);
}

describe("advisory", () => {
  it("computes ideal and waste", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:22, resetsAt:"2026-08-29T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 6, null, now);
    expect(adv.wastePct).toBeGreaterThan(0);
    expect(adv.urgency).toBe("burn now");
  });

  it("flags at risk when measured burn exhausts the quota before reset", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:16, periodStart:"2026-08-27T18:00:00+10:00", resetsAt:"2026-08-31T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 40, null, now);
    expect(adv.burnMeasured).toBe(true);
    expect(adv.recentRate).toBe(40);
    expect(adv.burnRate).toBe(40);
    expect(adv.daysToExhaust).toBeCloseTo(2.1, 1);
    expect(adv.status).toBe("at risk");
    expect(adv.aheadOfElapsed).toBe(true);
  });

  it("marks on track when burn stays under the ideal rate", () => {
    const now = new Date("2026-08-28T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:16, resetsAt:"2026-08-31T11:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 20, null, now);
    expect(adv.daysToExhaust).toBeCloseTo(4.2, 1);
    expect(adv.status).toBe("on track");
    expect(adv.aheadOfElapsed).toBe(false);
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

  it("treats a baseline-only entry as window-average pace, never a constant", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map([["kimi", { recent: null, baseline: 20 }]]), now);
    const adv = rec.advisories[0];
    expect(adv.burnMeasured).toBe(false);
    expect(adv.burnRate).toBeCloseTo(20, 5);
    expect(adv.paceSource).toBe("window-average");
    expect(adv.recentRate).toBeNull();
    expect(adv.baselineRate).toBe(20);
    // ideal is (100-60)/4 = 10%/day, so burning 20%/day exhausts early
    expect(adv.idealRate).toBeCloseTo(10, 5);
    expect(adv.status).toBe("at risk");
  });

  it("blends the recent rate with the baseline and keeps both visible", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map([["kimi", { recent: 3, baseline: 20 }]]), now);
    const adv = rec.advisories[0];
    expect(adv.burnRate).toBeCloseTo(11.5, 5);
    expect(adv.recentRate).toBe(3);
    expect(adv.baselineRate).toBe(20);
    expect(adv.burnMeasured).toBe(true);
    expect(adv.paceSource).toBe("recent");
  });

  it("waste follows the real pace, not a constant", () => {
    // 3% used over 1 day is 3%/day. The old code assumed 2%/day for every
    // provider it had no history for, so the waste it reported was invented.
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"codex", usedPct:3, periodStart:"2026-08-30T06:00:00+10:00",
                resetsAt:"2026-09-05T06:00:00+10:00" } as any;
    const adv = recommend([q], "any", new Map([["codex", { recent: null, baseline: 3 }]]), now).advisories[0];
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
    expect(rec.wastePct).toBeNull();
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
    const rec = recommend([freshKimi, measuredClaude], "any", new Map([["claude", { recent: null, baseline: 10 / 3 }]]), now);
    expect(rec.use).toBe("claude");
    expect(rec.recommendationBasis).toBe("known-waste");
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
    const rec = recommend([atRiskClaude, freshKimi], "any", new Map([["claude", { recent: 25, baseline: null }]]), now);
    expect(rec.use).toBe("kimi");
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.wastePct).toBeNull();
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
    expect(rec.wastePct).toBeNull();
    expect(rec.reason).toMatch(/Measuring pace; 90% remains with 3\.0d until reset/);
  });

  it("retains all providers in advisories and alternatives output", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q1 = { provider: "kimi", usedPct: 1, periodStart: "2026-08-31T05:30:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const q2 = { provider: "claude", usedPct: 80, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const q3 = { provider: "codex", usedPct: 10, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([q1, q2, q3], "any", new Map([["claude", { recent: 25, baseline: null }]]), now);
    expect(rec.advisories.map(a => a.provider)).toEqual(["kimi", "claude", "codex"]);
    expect(rec.alternatives.map(a => a.provider)).toEqual(["kimi", "claude", "codex"]);
  });

  it("leaves normal measured recommendations unchanged", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"codex", usedPct:3, periodStart:"2026-08-30T06:00:00+10:00", resetsAt:"2026-09-05T06:00:00+10:00" } as any;
    const rec = recommend([q], "any", new Map([["codex", { recent: null, baseline: 3 }]]), now);
    expect(rec.use).toBe("codex");
    expect(rec.recommendationBasis).toBe("known-waste");
    expect(rec.advisories[0].burnRate).toBeCloseTo(3, 5);
    expect(Math.round(rec.advisories[0].wastePct!)).toBe(82);
  });

  it("distinguishes recent and window-average pace sources under known-waste", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const recentProvider = {
      provider: "claude",
      usedPct: 10,
      periodStart: "2026-08-28T06:00:00+10:00",
      resetsAt: "2026-09-04T06:00:00+10:00",
    } as any;
    const windowAvgProvider = {
      provider: "kimi",
      usedPct: 10,
      periodStart: "2026-08-28T06:00:00+10:00",
      resetsAt: "2026-09-04T06:00:00+10:00",
    } as any;
    const recRecent = recommend([recentProvider], "any", new Map([["claude", { recent: 5, baseline: null }]]), now);
    expect(recRecent.recommendationBasis).toBe("known-waste");
    expect(recRecent.advisories[0].paceSource).toBe("recent");

    const recAvg = recommend([windowAvgProvider], "any", new Map([["kimi", { recent: null, baseline: 10 / 3 }]]), now);
    expect(recAvg.recommendationBasis).toBe("known-waste");
    expect(recAvg.advisories[0].paceSource).toBe("window-average");
  });

  it("returns no priority when the only measured provider sits on the boundary with no waste", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    // 50% used with 5 days left -> ideal rate = 10%/day. A forecast exactly on
    // the ideal sits inside the deadband (Watch) and leaves no avoidable waste.
    const boundaryClaude = {
      provider: "claude",
      usedPct: 50,
      periodStart: "2026-08-26T06:00:00+10:00",
      resetsAt: "2026-09-05T06:00:00+10:00",
    } as any;
    const rec = recommend([boundaryClaude], "any", new Map([["claude", { recent: 10, baseline: null }]]), now);
    expect(rec.use).toBe("none");
    expect(rec.recommendationBasis).toBe("none");
    // The all-Watch board routes to the no-candidate step; its copy must name
    // the amber tier, not just risk and exhaustion.
    expect(rec.reason).toBe("all quotas at risk, watch, or exhausted");
    expect(rec.advisories[0].status).toBe("watch");
    expect(rec.advisories[0].wastePct).toBe(0);
  });

  it("returns no recommendation when all quotas are at risk and no unknown headroom exists", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const atRisk1 = { provider: "claude", usedPct: 80, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const atRisk2 = { provider: "kimi", usedPct: 90, periodStart: "2026-08-28T06:00:00+10:00", resetsAt: "2026-09-04T06:00:00+10:00" } as any;
    const rec = recommend([atRisk1, atRisk2], "any", new Map([
      ["claude", { recent: 25, baseline: null }],
      ["kimi", { recent: 30, baseline: null }],
    ]), now);
    expect(rec.use).toBe("none");
    expect(rec.recommendationBasis).toBe("none");
    expect(rec.reason).toBe("all quotas at risk, watch, or exhausted");
  });

  it("carries the window average alongside the forecast pace", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const adv = computeAdvisory(q, 3, null, now);
    expect(adv.burnRate).toBe(3);
    expect(adv.avgPace).toBeCloseTo(20, 5);
    expect(adv.paceSource).toBe("recent");
  });

  it("withholds verdicts on a fresh window instead of annualizing noise", () => {
    // Live Muse case: 2% used ~2h into a new window. Annualizing would
    // fabricate ~24%/day and a Cap risk; the 6h gate keeps it unknown.
    const now = new Date("2026-09-14T02:00:00+10:00");
    const q = { provider:"muse", usedPct:2, periodStart:"2026-09-14T00:00:00+10:00",
                resetsAt:"2026-09-21T06:00:00+10:00" } as any;
    const adv = computeAdvisory(q, null, null, now);
    expect(adv.avgPace).toBeNull();
    expect(adv.status).toBe("unknown");
    expect(adv.urgency).toBe("on track");
    expect(adv.wastePct).toBeNull();
  });

  it("reports a null average before the window start is known", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"kimi", usedPct:60, resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    expect(computeAdvisory(q, 3, null, now).avgPace).toBeNull();
  });

  it("forces the capped verdict when nothing remains, even with flat burn", () => {
    const now = new Date("2026-08-31T06:00:00+10:00");
    const q = { provider:"grok", usedPct:100, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    for (const burn of [0, 100.3]) {
      const adv = computeAdvisory(q, burn, null, now);
      expect(adv.status).toBe("at risk");
      expect(adv.urgency).toBe("slow down");
      expect(adv.daysToExhaust).toBe(0);
      expect(adv.wastePct).toBe(0);
      expect(adv.avgPace).toBeCloseTo(100 / 3, 5);
      expect(adv.recentRate).toBeNull();
      expect(adv.baselineRate).toBeNull();
      expect(adv.aheadOfElapsed).toBeNull();
    }
  });

  it("forces the capped verdict when nothing remains and pace is unknown", () => {
    const now = new Date("2026-08-28T06:30:00+10:00");
    const q = { provider:"grok", usedPct:100, periodStart:"2026-08-28T06:00:00+10:00",
                resetsAt:"2026-09-04T06:00:00+10:00" } as any;
    const adv = computeAdvisory(q, null, null, now);
    expect(adv.status).toBe("at risk");
    expect(adv.urgency).toBe("slow down");
    expect(adv.daysToExhaust).toBe(0);
    expect(adv.wastePct).toBe(0);
    expect(adv.recentRate).toBeNull();
    expect(adv.baselineRate).toBeNull();
    expect(adv.aheadOfElapsed).toBeNull();
  });
});

describe("pace source derivation", () => {
  it("labels a recent input as measured recent and blends it", () => {
    const adv = boardAdv(boardQuota("kimi", 10, 30), 5, 3);
    expect(adv.burnRate).toBeCloseTo(4, 10);
    expect(adv.paceSource).toBe("recent");
    expect(adv.burnMeasured).toBe(true);
    expect(adv.recentRate).toBe(5);
    expect(adv.baselineRate).toBe(3);
  });

  it("labels a baseline-only forecast as window-average", () => {
    const adv = boardAdv(boardQuota("kimi", 10, 30), null, 3);
    expect(adv.burnRate).toBe(3);
    expect(adv.paceSource).toBe("window-average");
    expect(adv.burnMeasured).toBe(false);
    expect(adv.recentRate).toBeNull();
    expect(adv.baselineRate).toBe(3);
  });

  it("stays unknown when neither input exists", () => {
    const adv = boardAdv(boardQuota("kimi", 10, 30), null, null);
    expect(adv.burnRate).toBeNull();
    expect(adv.paceSource).toBe("unknown");
    expect(adv.status).toBe("unknown");
    expect(adv.recentRate).toBeNull();
    expect(adv.baselineRate).toBeNull();
    expect(adv.aheadOfElapsed).toBeNull();
  });
});

describe("verdict partition (16 Sept board)", () => {
  it("Antigravity: 6% used in the marginal band reads Watch, never Cap risk", () => {
    // One heavy 24h day (recent 25) against a small history (baseline 5)
    // blends to 15%/day: exhausts at 6.27d against 6.3d left -> deadband.
    const adv = boardAdv(boardQuota("agy", 6, 10), 25, 5);
    expect(adv.burnRate).toBeCloseTo(15, 5);
    expect(adv.recentRate).toBe(25);
    expect(adv.baselineRate).toBe(5);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
    expect(adv.wastePct).toBe(0);
  });

  it("Muse: 25% used against 35% elapsed fails the gate and reads Watch", () => {
    const adv = boardAdv(boardQuota("muse", 25, 35), 36, 8);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
  });

  it("Codex: 47% used against 56% elapsed fails the gate and reads Watch", () => {
    const adv = boardAdv(boardQuota("codex", 47, 56), 35, 10);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
  });

  it("Grok: ahead of elapsed and over pace stays Cap risk", () => {
    const adv = boardAdv(boardQuota("grok", 60, 40), 110, 10);
    expect(adv.status).toBe("at risk");
    expect(adv.aheadOfElapsed).toBe(true);
    expect(adv.urgency).toBe("slow down");
  });

  it("agy:3p: 67% used against 88% elapsed fails the gate and reads Watch", () => {
    const adv = boardAdv(boardQuota("agy:3p", 67, 88), 80, 40);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
  });

  it("Kimi: zero burn lands use soon and never ahead of elapsed", () => {
    const adv = boardAdv(boardQuota("kimi", 10, 30), 0, 0);
    expect(adv.status).toBe("on track");
    expect(adv.urgency).toBe("use soon");
    expect(adv.aheadOfElapsed).toBe(false);
    expect(adv.burnRate).toBe(0);
    expect(adv.recentRate).toBe(0);
  });

  it("Claude: gate passes and a hair over pace is Cap risk (baseline-sensitive per design 12.5)", () => {
    const q = boardQuota("claude", 65, 60);
    expect(boardAdv(q, 20, 10).status).toBe("at risk");
    // The same reading with a lower history baseline lands inside the
    // deadband: this verdict is the one the backtest must keep stable.
    expect(boardAdv(q, 20, 5).status).toBe("watch");
  });
});

describe("verdict partition table", () => {
  it("over with the gate passing is Cap risk", () => {
    const adv = boardAdv(boardQuota("claude", 80, 40), 30, 10);
    expect(adv.status).toBe("at risk");
    expect(adv.aheadOfElapsed).toBe(true);
    expect(adv.wastePct).toBe(0);
  });

  it("over with the gate failing is Watch", () => {
    const adv = boardAdv(boardQuota("kimi", 20, 60), 60, 20);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
  });

  it("marginal on either side of the reset boundary is Watch", () => {
    const q = boardQuota("codex", 50, 50); // gate passes at 50% used vs 50% elapsed
    const justUnder = boardAdv(q, 26, 0); // 13%/day exhausts just after the reset
    const justOver = boardAdv(q, 30, 0); // 15%/day exhausts just before the reset
    expect(justUnder.status).toBe("watch");
    expect(justOver.status).toBe("watch");
  });

  it("on track splits by urgency: burn now, use soon, save, on track", () => {
    const burnNow = boardAdv(boardQuota("codex", 10, 70), 2, 1);
    expect(burnNow.status).toBe("on track");
    expect(burnNow.urgency).toBe("burn now");

    const useSoon = boardAdv(boardQuota("kimi", 10, 30), 0, 0);
    expect(useSoon.urgency).toBe("use soon");

    const save = boardAdv(boardQuota("muse", 70, 50), 5, 3);
    expect(save.status).toBe("on track");
    expect(save.urgency).toBe("save");

    const clear = boardAdv(boardQuota("codex", 40, 50), 19, 10);
    expect(clear.status).toBe("on track");
    expect(clear.urgency).toBe("on track");
  });

  it("on track with a clearly-ahead position reports aheadOfElapsed true, never Behind pace", () => {
    // Ahead-and-cooling (design 12.10): 70% used at 50% elapsed, forecast under ideal.
    const adv = boardAdv(boardQuota("muse", 70, 50), 5, 3);
    expect(adv.status).toBe("on track");
    expect(adv.aheadOfElapsed).toBe(true);
    expect(adv.urgency).toBe("save");
  });
});

describe("estimated clocks", () => {
  it("caps an over-pace forecast at Watch and forces aheadOfElapsed false", () => {
    const adv = boardAdv(boardQuota("grok", 60, 40, { resetsAtEstimated: true }), 110, 10);
    expect(adv.status).toBe("watch");
    expect(adv.aheadOfElapsed).toBe(false);
  });

  it("keeps the exhausted verdict red on an estimated clock", () => {
    const adv = boardAdv(boardQuota("grok", 100, 40, { resetsAtEstimated: true }), 0, 0);
    expect(adv.status).toBe("at risk");
    expect(adv.wastePct).toBe(0);
    expect(adv.daysToExhaust).toBe(0);
    expect(adv.aheadOfElapsed).toBeNull();
  });

  it("demotes burn now to use soon when the reset is estimated", () => {
    const q = boardQuota("codex", 10, 70);
    expect(boardAdv(q, 2, 1).urgency).toBe("burn now");
    const estimated = boardAdv(boardQuota("codex", 10, 70, { resetsAtEstimated: true }), 2, 1);
    expect(estimated.urgency).toBe("use soon");
    expect(estimated.status).toBe("on track");
  });
});

describe("recommend verified-first ranking", () => {
  it("prefers a verified 18h deadline over an estimated 7d phantom with larger waste", () => {
    const verified = boardQuota("claude", 95, (150 / 168) * 100);
    const phantom = boardQuota("grok", 10, 0, { resetsAtEstimated: true });
    const pace = new Map([
      ["claude", { recent: 1, baseline: null }],
      ["grok", { recent: 0.5, baseline: null }],
    ]);
    const rec = recommend([verified, phantom], "any", pace, BOARD_NOW);
    const claude = rec.advisories.find((a) => a.provider === "claude")!;
    const grok = rec.advisories.find((a) => a.provider === "grok")!;
    expect(grok.wastePct!).toBeGreaterThan(claude.wastePct!);
    expect(rec.use).toBe("claude");
    expect(rec.recommendationBasis).toBe("known-waste");
  });

  it("falls back to the estimated pool only when no verified candidate has waste", () => {
    const phantom = boardQuota("grok", 10, 0, { resetsAtEstimated: true });
    const rec = recommend([phantom], "any", new Map([["grok", { recent: 0.5, baseline: null }]]), BOARD_NOW);
    expect(rec.use).toBe("grok");
    expect(rec.recommendationBasis).toBe("known-waste");
  });

  it("keeps unknown-headroom ranking for entries without pace", () => {
    const freshKimi = boardQuota("kimi", 10, 30);
    const freshClaude = boardQuota("claude", 20, 30);
    const rec = recommend([freshKimi, freshClaude], "any", new Map(), BOARD_NOW);
    expect(rec.recommendationBasis).toBe("unknown-headroom");
    expect(rec.use).toBe("kimi");
  });
});
