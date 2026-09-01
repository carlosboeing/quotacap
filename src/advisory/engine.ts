import type { Quota } from "../adapters/types.js";
import type { Advisory, Urgency, BurnStatus, PaceSource, RecommendationBasis } from "./types.js";

const DAY_MS = 86400000;

/**
 * Pace from a single reading.
 *
 * `usedPct` is a running total since the window opened, and `periodStart` is
 * a required field every adapter sets, so a pace is always computable from
 * one poll. Returns null only when `periodStart` is missing or unparseable.
 */
export function averagePace(q: Quota, now = new Date()): number | null {
  if (!q.periodStart) return null;
  const start = new Date(q.periodStart).getTime();
  if (Number.isNaN(start)) return null;
  const elapsedDays = (now.getTime() - start) / DAY_MS;
  if (elapsedDays < 1 / 24) return null; // under an hour in: not yet meaningful
  return Math.max(0, q.usedPct / elapsedDays);
}

export function computeAdvisory(q:Quota, burnRate:number | null, now=new Date(), paceSourceOrMeasured:PaceSource|boolean="unknown"): Advisory {
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime()-now.getTime())/DAY_MS);
  const remaining = 100 - q.usedPct;
  const idealRate = remaining / daysLeft;

  let paceSource: PaceSource;
  let burnMeasured: boolean;
  if (burnRate === null) {
    paceSource = "unknown";
    burnMeasured = false;
  } else if (typeof paceSourceOrMeasured === "string") {
    paceSource = paceSourceOrMeasured;
    burnMeasured = paceSource === "recent";
  } else {
    burnMeasured = paceSourceOrMeasured;
    paceSource = burnMeasured ? "recent" : "window-average";
  }

  if (burnRate === null) {
    return {
      provider: q.provider,
      daysLeft,
      remaining,
      idealRate,
      burnRate: null,
      burnMeasured: false,
      paceSource: "unknown",
      daysToExhaust: null,
      status: "unknown",
      wastePct: null,
      urgency: "on track",
    };
  }
  const wastePct = Math.max(0, remaining - burnRate*daysLeft);
  // burn > ideal is exactly "quota exhausts before reset": remaining/burn < daysLeft
  const daysToExhaust = burnRate > 0 ? remaining / burnRate : Infinity;
  const status: BurnStatus = daysToExhaust < daysLeft ? "at risk" : "on track";
  let urgency:Urgency = "on track";
  if(wastePct>30 && daysLeft<3) urgency="burn now";
  else if(wastePct>20 && daysLeft<7) urgency="use soon";
  else if(burnRate > idealRate*1.4) urgency="slow down";
  else if(wastePct>10) urgency="save";
  return { provider:q.provider, daysLeft, remaining, idealRate, burnRate, burnMeasured, paceSource, daysToExhaust, status, wastePct, urgency };
}

export function recommend(quotas:Quota[], _task:string, burnByProvider=new Map<string,number>(), now=new Date()){
  if(!quotas.length) {
    return {
      use: "none",
      reason: "no quotas yet",
      wastePct: 0,
      idealRate: 0,
      recommendationBasis: "none" as RecommendationBasis,
      alternatives: [] as Quota[],
      advisories: [] as Advisory[],
    };
  }

  // Build advisories for every quota with honest pace sources.
  const advisories = quotas.map(q => {
    const recent = burnByProvider.get(q.provider);
    if (recent !== undefined) {
      return computeAdvisory(q, recent, now, "recent");
    }
    const avg = averagePace(q, now);
    if (avg !== null) {
      return computeAdvisory(q, avg, now, "window-average");
    }
    return computeAdvisory(q, null, now, "unknown");
  });

  // 1. Prefer measured providers with positive avoidable waste (actionable "Use more" candidates).
  const positiveWaste = advisories.filter(
    (a): a is Advisory & { wastePct: number; burnRate: number } =>
      a.paceSource !== "unknown" && a.wastePct !== null && a.wastePct > 0
  );

  if (positiveWaste.length > 0) {
    const burnNow = positiveWaste.filter(a => a.urgency === "burn now");
    const pool = burnNow.length ? burnNow : positiveWaste;
    const use = pool.sort((a, b) => b.wastePct - a.wastePct)[0];
    return {
      use: use.provider,
      reason: `${Math.round(use.wastePct)}% waste in ${use.daysLeft.toFixed(1)}d`,
      wastePct: use.wastePct,
      idealRate: use.idealRate,
      recommendationBasis: "known-waste" as RecommendationBasis,
      alternatives: quotas,
      advisories,
    };
  }

  // 2. Low-confidence fallback: rank unknown providers by remaining headroom (remaining / daysLeft).
  const unknownProviders = advisories.filter(
    a => a.paceSource === "unknown" && a.remaining > 0
  );

  if (unknownProviders.length > 0) {
    const use = unknownProviders.sort(
      (a, b) => (b.remaining / b.daysLeft) - (a.remaining / a.daysLeft)
    )[0];
    return {
      use: use.provider,
      reason: `Measuring pace; ${Math.round(use.remaining)}% remains with ${use.daysLeft.toFixed(1)}d until reset`,
      wastePct: null,
      idealRate: use.idealRate,
      recommendationBasis: "unknown-headroom" as RecommendationBasis,
      alternatives: quotas,
      advisories,
    };
  }

  // 3. Check if all measured providers are healthy and on pace (status "on track").
  const onTrack = advisories.filter(
    a => a.paceSource !== "unknown" && a.status === "on track" && a.remaining > 0
  );

  if (onTrack.length > 0) {
    return {
      use: "none",
      reason: "No subscription needs priority",
      wastePct: 0,
      idealRate: 0,
      recommendationBasis: "none" as RecommendationBasis,
      alternatives: quotas,
      advisories,
    };
  }

  // 4. No meaningful candidate (e.g. all quotas at risk or exhausted).
  return {
    use: "none",
    reason: "all quotas at risk or exhausted",
    wastePct: 0,
    idealRate: 0,
    recommendationBasis: "none" as RecommendationBasis,
    alternatives: quotas,
    advisories,
  };
}
