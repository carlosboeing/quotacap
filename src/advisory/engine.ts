import type { Quota } from "../adapters/types.js";
import type { Advisory, Urgency, BurnStatus, PaceSource, RecommendationBasis, BindingWindow } from "./types.js";
import { MIN_PACE_SPAN_DAYS, BLEND_K, RISK_MARGIN, GATE_TOL } from "./types.js";

const DAY_MS = 86400000;

/**
 * Pace from a single reading.
 *
 * `weeklyPct` is a running total since the window opened, and `periodStart` is
 * a required field every adapter sets, so a pace is always computable from
 * one poll. Returns null when `periodStart` is missing or unparseable, or
 * when less than MIN_PACE_SPAN_DAYS has elapsed (annualizing a smaller
 * denominator fabricates verdicts).
 */
export function averagePace(q: Quota, now = new Date()): number | null {
  if (!q.periodStart) return null;
  const start = new Date(q.periodStart).getTime();
  if (Number.isNaN(start)) return null;
  const elapsedDays = (now.getTime() - start) / DAY_MS;
  if (elapsedDays < MIN_PACE_SPAN_DAYS) return null;
  const pace = q.weeklyPct / elapsedDays;
  if (!Number.isFinite(pace)) return null;
  return Math.max(0, pace);
}

export function blendForecast(recent: number | null, baseline: number | null): number | null {
  if (recent === null) return baseline;
  if (baseline === null) return recent;
  return Math.max(0, baseline + BLEND_K * (recent - baseline));
}

export function baselineFor(historyAvg: number | null, q: Quota, now: Date): number | null {
  if (historyAvg !== null) return historyAvg;
  return averagePace(q, now);
}

/**
 * Position in the window from raw timestamps, clamped to 0..100. Derived
 * elapsed time, never the clamped `daysLeft`: an estimated reset makes this
 * fictional, which is exactly why the gate and the ahead test also check
 * `resetsAtEstimated`. Returns null when either timestamp is missing or
 * unparseable, the window has no positive span, or no time has elapsed.
 */
function elapsedPctOf(q: Quota, now: Date): number | null {
  if (!q.periodStart) return null;
  const start = new Date(q.periodStart).getTime();
  const resets = new Date(q.resetsAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(resets)) return null;
  const span = resets - start;
  if (!(span > 0)) return null;
  const elapsed = now.getTime() - start;
  if (!(elapsed > 0)) return null;
  return Math.min(100, Math.max(0, (elapsed / span) * 100));
}

export function computeAdvisory(q: Quota, recent: number | null, baseline: number | null, now = new Date()): Advisory {
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime()-now.getTime())/DAY_MS);
  const remaining = 100 - q.weeklyPct;
  const idealRate = remaining / daysLeft;
  const avgPace = averagePace(q, now);
  // Nothing left to burn: force the capped verdict even when the recent
  // window is flat (burn 0 at 100% used must not read "on track").
  const exhausted = remaining <= 0;
  const burnRate = blendForecast(recent, baseline);

  // Above every return: the unknown-pace path below is exactly what pool 2
  // ranks, so a binding computed later would leave it on weekly numbers.
  const weeklyHeadroom = remaining / daysLeft;
  let bindingWindow: BindingWindow = "weekly";
  let bindingRemaining = remaining;
  let bindingDaysLeft = daysLeft;

  if (q.monthlyKind === "included" && typeof q.monthlyPct === "number" && q.monthlyResetsAt) {
    const monthlyRemaining =
      q.monthlyStatus === "exhausted" ? 0 : Math.max(0, 100 - q.monthlyPct);
    const monthlyDaysLeft = Math.max(
      0.1,
      (new Date(q.monthlyResetsAt).getTime() - now.getTime()) / DAY_MS
    );
    const monthlyHeadroom = monthlyRemaining / monthlyDaysLeft;
    if (monthlyHeadroom < weeklyHeadroom || monthlyRemaining === 0) {
      bindingWindow = "monthly";
      bindingRemaining = monthlyRemaining;
      bindingDaysLeft = monthlyDaysLeft;
    }
  }

  // paceSource describes recent availability; the blend's composition is
  // carried by recentRate and baselineRate.
  const paceSource: PaceSource = recent !== null ? "recent" : burnRate !== null ? "window-average" : "unknown";
  const burnMeasured = recent !== null;

  if (burnRate === null) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate: null,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured: false,
      paceSource: "unknown",
      daysToExhaust: exhausted ? 0 : null,
      status: exhausted ? "at risk" : "unknown",
      wastePct: exhausted ? 0 : null,
      urgency: exhausted ? "slow down" : "on track",
      bindingWindow,
      bindingRemaining,
      bindingDaysLeft,
    };
  }
  if (exhausted) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate,
      recentRate: null,
      baselineRate: null,
      aheadOfElapsed: null,
      avgPace,
      burnMeasured,
      paceSource,
      daysToExhaust: 0,
      status: "at risk",
      wastePct: 0,
      urgency: "slow down",
      bindingWindow,
      bindingRemaining,
      bindingDaysLeft,
    };
  }

  // Red needs a deadband margin and a cumulatively-ahead position on a
  // verified clock; a missing or estimated clock caps at Watch.
  const elapsed = elapsedPctOf(q, now);
  const estimated = q.resetsAtEstimated === true;
  const gate = elapsed !== null && !estimated && q.weeklyPct >= elapsed * (1 - GATE_TOL);
  const aheadOfElapsed = elapsed !== null && !estimated && q.weeklyPct > elapsed * (1 + GATE_TOL);

  const wastePct = Math.max(0, remaining - burnRate*daysLeft);
  const daysToExhaust = burnRate > 0 ? remaining / burnRate : Infinity;
  const over = daysToExhaust < daysLeft * (1 - RISK_MARGIN);
  const marginal = !over && daysToExhaust < daysLeft * (1 + RISK_MARGIN);
  let status: BurnStatus;
  if (over && gate) status = "at risk";
  else if (over || marginal) status = "watch";
  else status = "on track";

  let urgency:Urgency = "on track";
  if(wastePct>30 && daysLeft<3) urgency="burn now";
  else if(wastePct>20 && daysLeft<7) urgency="use soon";
  else if(burnRate > idealRate*1.4) urgency="slow down";
  else if(wastePct>10) urgency="save";
  if (estimated && urgency === "burn now") urgency = "use soon";

  return { provider:q.provider, daysLeft, remaining, idealRate, burnRate, recentRate: recent, baselineRate: baseline, aheadOfElapsed, avgPace, burnMeasured, paceSource, daysToExhaust, status, wastePct, urgency, bindingWindow, bindingRemaining, bindingDaysLeft };
}

/**
 * Known-waste sort key. `wastePct` is a flow (budget forecast to go unspent
 * by the weekly deadline); `bindingRemaining` is a stock. The binding window's
 * headroom per day, priced over the weekly days-left the pool sorts on, caps
 * the claim at what the account can actually absorb. Weekly-bound providers
 * are untouched: the ratio is 1 and `wastePct <= remaining` always.
 */
function rankWaste(a: Advisory & { wastePct: number }): number {
  const affordable = a.bindingRemaining * (a.daysLeft / a.bindingDaysLeft);
  return Math.min(a.wastePct, affordable);
}

export function recommend(quotas:Quota[], _task:string, paceByProvider=new Map<string,{ recent: number | null; baseline: number | null }>(), now=new Date()){
  if(!quotas.length) {
    return {
      use: "none",
      reason: "no quotas yet",
      wastePct: 0,
      idealRate: 0,
      recommendationBasis: "none" as RecommendationBasis,
      bindingWindow: "weekly" as BindingWindow,
      alternatives: [] as Quota[],
      advisories: [] as Advisory[],
    };
  }

  // Callers own the blend inputs; an entry without pace stays honest about it.
  const advisories = quotas.map(q => {
    const pace = paceByProvider.get(q.provider);
    if (pace) return computeAdvisory(q, pace.recent, pace.baseline, now);
    return computeAdvisory(q, null, null, now);
  });

  // Ranking must not assert a fictional deadline: estimated-clock candidates
  // are a fallback pool, read from the flags on the quotas already received.
  const estimatedProviders = new Set(quotas.filter(q => q.resetsAtEstimated === true).map(q => q.provider));

  // 1. Prefer measured providers with positive avoidable waste (actionable "Use more" candidates).
  const positiveWaste = advisories.filter(
    (a): a is Advisory & { wastePct: number; burnRate: number } =>
      a.paceSource !== "unknown" && a.wastePct !== null && a.wastePct > 0 && a.bindingRemaining > 0
  );

  if (positiveWaste.length > 0) {
    const verified = positiveWaste.filter(a => !estimatedProviders.has(a.provider));
    const pool = verified.length ? verified : positiveWaste.filter(a => estimatedProviders.has(a.provider));
    const burnNow = pool.filter(a => a.urgency === "burn now" && a.bindingWindow === "weekly");
    const use = (burnNow.length ? burnNow : pool).sort((a, b) => rankWaste(b) - rankWaste(a))[0];
    return {
      use: use.provider,
      reason: use.bindingWindow === "monthly"
        ? `${Math.round(use.bindingRemaining)}% of month left in ${use.bindingDaysLeft.toFixed(1)}d`
        : `${Math.round(use.wastePct)}% waste in ${use.daysLeft.toFixed(1)}d`,
      wastePct: rankWaste(use),
      idealRate: use.idealRate,
      recommendationBasis: "known-waste" as RecommendationBasis,
      bindingWindow: use.bindingWindow,
      alternatives: quotas,
      advisories,
    };
  }

  // 2. Low-confidence fallback: rank unknown providers by remaining headroom (remaining / daysLeft).
  const unknownProviders = advisories.filter(
    a => a.paceSource === "unknown" && a.bindingRemaining > 0
  );

  if (unknownProviders.length > 0) {
    const use = unknownProviders.sort(
      (a, b) => (b.bindingRemaining / b.bindingDaysLeft) - (a.bindingRemaining / a.bindingDaysLeft)
    )[0];
    return {
      use: use.provider,
      reason: use.bindingWindow === "monthly"
        ? `Measuring pace; ${Math.round(use.bindingRemaining)}% of month left with ${use.bindingDaysLeft.toFixed(1)}d until reset`
        : `Measuring pace; ${Math.round(use.remaining)}% remains with ${use.daysLeft.toFixed(1)}d until reset`,
      wastePct: null,
      idealRate: use.idealRate,
      recommendationBasis: "unknown-headroom" as RecommendationBasis,
      bindingWindow: use.bindingWindow,
      alternatives: quotas,
      advisories,
    };
  }

  // 3. No meaningful candidate (e.g. all quotas at risk, watch, or exhausted).
  return {
    use: "none",
    reason: "all quotas at risk, watch, or exhausted",
    wastePct: 0,
    idealRate: 0,
    recommendationBasis: "none" as RecommendationBasis,
    bindingWindow: "weekly" as BindingWindow,
    alternatives: quotas,
    advisories,
  };
}
