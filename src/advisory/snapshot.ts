import type { Quota } from "../adapters/types.js";
import { getAllLatest, getBurnRates } from "../store/quotas.js";
import { getAttempts, type AttemptRecord } from "../store/attempts.js";
import { recommend, averagePace, computeAdvisory } from "./engine.js";
import type {
  Advisory,
  ExclusionReason,
  ProviderSnapshot,
  StateSnapshot,
  Recommendation,
} from "./types.js";

export const STALE_MS = 60 * 60 * 1000;

export interface SnapshotOptions {
  enabledProviders: string[];
  now?: Date;
  runtime: {
    available: boolean;
    ready: boolean;
    polling: "idle" | "in-progress" | "cooldown";
    lastCompletedPollAt: string | null;
    version: string;
    update?: {
      current: string;
      latest: string | null;
      upToDate: boolean;
      checkedAt: string | null;
    };
  };
}

function normalizeAdvisory(adv: Advisory | null): Advisory | null {
  if (!adv) return null;
  return {
    ...adv,
    daysLeft: Number.isFinite(adv.daysLeft) ? adv.daysLeft : 0,
    remaining: Number.isFinite(adv.remaining) ? adv.remaining : 0,
    idealRate: Number.isFinite(adv.idealRate) ? adv.idealRate : 0,
    burnRate: adv.burnRate !== null && Number.isFinite(adv.burnRate) ? adv.burnRate : null,
    daysToExhaust: adv.daysToExhaust !== null && Number.isFinite(adv.daysToExhaust) ? adv.daysToExhaust : null,
    wastePct: adv.wastePct !== null && Number.isFinite(adv.wastePct) ? adv.wastePct : null,
  };
}

export function buildSnapshot(db: any, opts: SnapshotOptions): StateSnapshot {
  const now = opts.now ?? new Date();
  const asOf = now.toISOString();
  const asOfMs = now.getTime();

  // 1. Read latest quotas and attempts
  const allQuotas = getAllLatest(db) as Quota[];
  const quotaMap = new Map<string, Quota>();
  const storedIds = new Set<string>();
  for (const q of allQuotas) {
    quotaMap.set(q.provider, q);
    storedIds.add(q.provider);
  }

  const allAttempts = getAttempts(db) as AttemptRecord[];
  const attemptMap = new Map<string, AttemptRecord>();
  for (const a of allAttempts) {
    attemptMap.set(a.provider, a);
    storedIds.add(a.provider);
  }

  const unionIds = Array.from(new Set([...opts.enabledProviders, ...storedIds])).sort((a, b) =>
    a.localeCompare(b)
  );

  const burnRates = getBurnRates(db, asOfMs);

  const providerSnapshots: ProviderSnapshot[] = [];
  const eligibleQuotas: Quota[] = [];
  const burnSubset = new Map<string, number>();
  const allValidAdvisories: Advisory[] = [];

  for (const id of unionIds) {
    const quota = quotaMap.get(id) ?? null;
    let attempt = attemptMap.get(id) ?? null;
    // Attempt lookup for agy:3p falls back to agy attempt row
    if (!attempt && id === "agy:3p") {
      attempt = attemptMap.get("agy") ?? null;
    }

    const enabled =
      opts.enabledProviders.includes(id) ||
      (id.startsWith("agy:") && opts.enabledProviders.includes("agy")) ||
      quota?.source === "manual";

    const lastSuccessAt = attempt?.succeededAt ?? null;

    let isInvalid = false;
    let ageMs: number | null = null;
    let stale = false;
    let resetPassed = false;
    let providerFailed = false;

    if (quota !== null) {
      const resetsMs = new Date(quota.resetsAt).getTime();
      const fetchedMs = new Date(quota.fetchedAt).getTime();

      if (
        !Number.isFinite(quota.usedPct) ||
        quota.usedPct < 0 ||
        quota.usedPct > 100 ||
        Number.isNaN(resetsMs) ||
        Number.isNaN(fetchedMs)
      ) {
        isInvalid = true;
      }

      if (!Number.isNaN(fetchedMs)) {
        ageMs = Math.max(0, asOfMs - fetchedMs);
        if (ageMs > STALE_MS) {
          stale = true;
        }
      }

      if (!Number.isNaN(resetsMs) && resetsMs <= asOfMs) {
        resetPassed = true;
      }
    }

    if (attempt !== null && !attempt.success) {
      if (
        attempt.succeededAt === null ||
        new Date(attempt.attemptedAt).getTime() > new Date(attempt.succeededAt).getTime()
      ) {
        providerFailed = true;
      }
    }

    // Precedence: invalid, reset-passed, provider-failed, stale, not-reporting
    let exclusionReason: ExclusionReason = null;
    if (quota === null) {
      exclusionReason = "not-reporting";
    } else if (isInvalid) {
      exclusionReason = "invalid";
    } else if (resetPassed) {
      exclusionReason = "reset-passed";
    } else if (providerFailed) {
      exclusionReason = "provider-failed";
    } else if (stale) {
      exclusionReason = "stale";
    }

    // Reporting requires a quota row with no stale, reset-passed, invalid, or failed flags.
    // Offline (runtime.available=false) forces reporting=false for stale rows.
    const reporting = quota !== null && exclusionReason === null;

    // Advisory computation
    let rawAdvisory: Advisory | null = null;
    if (quota !== null && !isInvalid) {
      const recentBurn = burnRates.get(id);
      if (recentBurn !== undefined) {
        rawAdvisory = computeAdvisory(quota, recentBurn, now, "recent");
      } else {
        const avg = averagePace(quota, now);
        if (avg !== null) {
          rawAdvisory = computeAdvisory(quota, avg, now, "window-average");
        } else {
          rawAdvisory = computeAdvisory(quota, null, now, "unknown");
        }
      }
    }

    const advisory = normalizeAdvisory(rawAdvisory);

    // Controlled evidence vocabulary
    const evidence: string[] = [];
    if (advisory?.burnMeasured) {
      evidence.push("measured");
    } else if (advisory?.paceSource === "window-average") {
      evidence.push("window-average");
    }
    if (quota?.resetsAtEstimated) {
      evidence.push("estimated-reset");
    }

    if (advisory) {
      allValidAdvisories.push(advisory);
    }

    if (enabled && quota !== null && exclusionReason === null) {
      eligibleQuotas.push(quota);
      if (burnRates.has(id)) {
        burnSubset.set(id, burnRates.get(id)!);
      }
    }

    providerSnapshots.push({
      id,
      enabled,
      quota,
      lastAttempt: attempt,
      lastSuccessAt,
      reporting,
      stale,
      resetPassed,
      ageMs,
      evidence,
      exclusionReason,
      advisory,
    });
  }

  // 2. Recommendation: ranked from eligible providers only; advisories cover all valid rows
  let recommendation: Recommendation;
  if (!eligibleQuotas.length) {
    recommendation = {
      use: "none",
      reason: "no quotas yet",
      wastePct: null,
      idealRate: 0,
      recommendationBasis: "none",
      alternatives: [],
      advisories: allValidAdvisories,
    };
  } else {
    const rec = recommend(eligibleQuotas, "any", burnSubset, now);
    const chosenProvider = eligibleQuotas.find((q) => q.provider === rec.use);
    let reason = rec.reason;
    if (chosenProvider?.resetsAtEstimated) {
      if (reason.includes("waste in")) {
        reason = reason.replace("waste in", "estimated waste in");
      } else if (reason.includes("until reset")) {
        reason = reason.replace("until reset", "until estimated reset");
      } else if (!reason.includes("estimated")) {
        reason = `${reason} (estimated)`;
      }
    }

    recommendation = {
      ...rec,
      reason,
      wastePct: rec.wastePct !== null && Number.isFinite(rec.wastePct) ? rec.wastePct : null,
      idealRate: Number.isFinite(rec.idealRate) ? rec.idealRate : 0,
      advisories: allValidAdvisories,
    };
  }

  return {
    asOf,
    runtime: opts.runtime,
    providers: providerSnapshots,
    recommendation,
  };
}

export function projectQuotasResponse(s: StateSnapshot): any[] {
  return s.providers
    .filter((p) => p.quota !== null)
    .map((p) => ({
      ...p.quota,
      stale: p.stale,
      ageMs: p.ageMs,
      evidence: p.evidence,
      exclusionReason: p.exclusionReason,
    }));
}

export function projectRecommendationResponse(s: StateSnapshot, _task = "any"): Recommendation {
  return s.recommendation;
}

