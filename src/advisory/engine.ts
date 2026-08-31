import type { Quota } from "../adapters/types.js";
import type { Advisory, Urgency, BurnStatus } from "./types.js";

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

export function computeAdvisory(q:Quota, burnRate:number, now=new Date(), burnMeasured=false): Advisory {
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime()-now.getTime())/DAY_MS);
  const remaining = 100 - q.usedPct;
  const idealRate = remaining / daysLeft;
  const wastePct = Math.max(0, remaining - burnRate*daysLeft);
  // burn > ideal is exactly "quota exhausts before reset": remaining/burn < daysLeft
  const daysToExhaust = burnRate > 0 ? remaining / burnRate : Infinity;
  const status: BurnStatus = daysToExhaust < daysLeft ? "at risk" : "on track";
  let urgency:Urgency = "on track";
  if(wastePct>30 && daysLeft<3) urgency="burn now";
  else if(wastePct>20 && daysLeft<7) urgency="use soon";
  else if(burnRate > idealRate*1.4) urgency="slow down";
  else if(wastePct>10) urgency="save";
  return { provider:q.provider, daysLeft, remaining, idealRate, burnRate, burnMeasured, daysToExhaust, status, wastePct, urgency };
}

export function recommend(quotas:Quota[], _task:string, burnByProvider=new Map<string,number>(), now=new Date()){
  if(!quotas.length) return { use: "none", reason: "no quotas yet", wastePct:0, idealRate:0, alternatives: [] as Quota[], advisories: [] as Advisory[] };
  // Recent pace when history supports it, otherwise the average since the
  // window opened. Both are observations. Never substitute a constant: a made
  // up rate makes an unused quota look inexhaustible, which is how a row came
  // to read "on track" beside "87% waste".
  const advisories = quotas.map(q => {
    const recent = burnByProvider.get(q.provider);
    const pace = recent ?? averagePace(q, now) ?? 0;
    return computeAdvisory(q, pace, now, recent !== undefined);
  });
  const burnNow = advisories.filter(a=>a.urgency==="burn now");
  const pool = burnNow.length? burnNow : advisories;
  const use = pool.sort((a,b)=> b.wastePct - a.wastePct)[0];
  return { use: use.provider, reason: `${Math.round(use.wastePct)}% waste in ${use.daysLeft.toFixed(1)}d`, wastePct:use.wastePct, idealRate:use.idealRate, alternatives: quotas, advisories };
}
