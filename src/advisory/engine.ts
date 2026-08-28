import type { Quota } from "../adapters/types.js";
import type { Advisory, Urgency } from "./types.js";
export function computeAdvisory(q:Quota, burnRate:number, now=new Date()): Advisory {
  const resets = new Date(q.resetsAt);
  const daysLeft = Math.max(0.1, (resets.getTime()-now.getTime())/86400000);
  const remaining = 100 - q.usedPct;
  const idealRate = remaining / daysLeft;
  const wastePct = Math.max(0, remaining - burnRate*daysLeft);
  let urgency:Urgency = "on track";
  if(wastePct>30 && daysLeft<3) urgency="burn now";
  else if(wastePct>20 && daysLeft<7) urgency="use soon";
  else if(burnRate > idealRate*1.4) urgency="slow down";
  else if(wastePct>10) urgency="save";
  return { provider:q.provider, daysLeft, remaining, idealRate, burnRate, wastePct, urgency };
}
export function recommend(quotas:Quota[], _task:string, burnByProvider=new Map<string,number>(), now=new Date()){
  if(!quotas.length) return { use: "none", reason: "no quotas yet", wastePct:0, idealRate:0, alternatives: [] as Quota[], advisories: [] as Advisory[] };
  const advisories = quotas.map(q=> computeAdvisory(q, burnByProvider.get(q.provider)?? 2, now));
  const burnNow = advisories.filter(a=>a.urgency==="burn now");
  const pool = burnNow.length? burnNow : advisories;
  const use = pool.sort((a,b)=> b.wastePct - a.wastePct)[0];
  return { use: use.provider, reason: `${Math.round(use.wastePct)}% waste in ${use.daysLeft.toFixed(1)}d`, wastePct:use.wastePct, idealRate:use.idealRate, alternatives: quotas, advisories };
}
