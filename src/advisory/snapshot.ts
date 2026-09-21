import type { Quota, QuotaWire } from "../adapters/types.js";
import { getAllLatest, getBurnRates, getHistoryBaseline, getWindowCloses } from "../store/quotas.js";
import { getAttempts, type AttemptRecord } from "../store/attempts.js";
import { getCatalogs } from "../store/catalogs.js";
import { emptyCatalog } from "../catalog/types.js";
import { recommend, baselineFor, computeAdvisory } from "./engine.js";
import { providerIdentity } from "./provider-names.js";
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
  providerNames?: Record<string, string>;
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
    detectedProviders?: string[];
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
    recentRate: adv.recentRate != null && Number.isFinite(adv.recentRate) ? adv.recentRate : null,
    baselineRate: adv.baselineRate != null && Number.isFinite(adv.baselineRate) ? adv.baselineRate : null,
    aheadOfElapsed: typeof adv.aheadOfElapsed === "boolean" ? adv.aheadOfElapsed : null,
    avgPace: adv.avgPace !== null && Number.isFinite(adv.avgPace) ? adv.avgPace : null,
    daysToExhaust: adv.daysToExhaust !== null && Number.isFinite(adv.daysToExhaust) ? adv.daysToExhaust : null,
    wastePct: adv.wastePct !== null && Number.isFinite(adv.wastePct) ? adv.wastePct : null,
    bindingWindow: adv.bindingWindow === "monthly" ? "monthly" : "weekly",
    bindingRemaining: Number.isFinite(adv.bindingRemaining)
      ? adv.bindingRemaining
      : Number.isFinite(adv.remaining) ? adv.remaining : 0,
    bindingDaysLeft: Number.isFinite(adv.bindingDaysLeft)
      ? adv.bindingDaysLeft
      : Number.isFinite(adv.daysLeft) ? adv.daysLeft : 0,
  };
}

export function buildSnapshot(db: any, opts: SnapshotOptions): StateSnapshot {
  const now = opts.now ?? new Date();
  const asOf = now.toISOString();
  const asOfMs = now.getTime();

  // 1. Read latest quotas and attempts
  const allQuotas = getAllLatest(db) as QuotaWire[];
  const quotaMap = new Map<string, QuotaWire>();
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
  const history = getHistoryBaseline(db);
  const catalogMap = getCatalogs(db);

  const providerSnapshots: ProviderSnapshot[] = [];
  const eligibleQuotas: Quota[] = [];
  const paceByProvider = new Map<string, { recent: number | null; baseline: number | null }>();
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
        !Number.isFinite(quota.weeklyPct) ||
        quota.weeklyPct < 0 ||
        quota.weeklyPct > 100 ||
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

    // Advisory computation: the engine blends recent toward the history
    // baseline internally; this loop is the single place both inputs form.
    let rawAdvisory: Advisory | null = null;
    let pace: { recent: number | null; baseline: number | null } | null = null;
    if (quota !== null && !isInvalid) {
      const recent = burnRates.get(id) ?? null;
      const baseline = baselineFor(history.get(id) ?? null, quota, now);
      pace = { recent, baseline };
      rawAdvisory = computeAdvisory(quota, recent, baseline, now);
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
      if (pace) paceByProvider.set(id, pace);
    }

    const catalog = catalogMap.get(id) ?? emptyCatalog();

    providerSnapshots.push({
      id,
      ...providerIdentity(id, opts.providerNames),
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
      lastCloses: getWindowCloses(db, id, 4),
      catalog,
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
      models: [],
      catalogStatus: "unfetched",
      catalogFetchedAt: null,
      alternatives: [],
      advisories: allValidAdvisories,
    };
  } else {
    const rec = recommend(eligibleQuotas, "any", paceByProvider, now);
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

    const pickCatalog = catalogMap.get(rec.use) ?? emptyCatalog();
    const alternativesWithCatalog = (rec.alternatives ?? []).map((alt: any) => ({
      ...alt,
      catalog: catalogMap.get(alt.provider) ?? emptyCatalog(),
    }));

    recommendation = {
      ...rec,
      reason,
      wastePct: rec.wastePct !== null && Number.isFinite(rec.wastePct) ? rec.wastePct : null,
      idealRate: Number.isFinite(rec.idealRate) ? rec.idealRate : 0,
      models: pickCatalog.listed,
      catalogStatus: rec.use === "none" ? "unfetched" : pickCatalog.status,
      catalogFetchedAt: pickCatalog.fetchedAt,
      alternatives: alternativesWithCatalog,
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
      displayName: p.displayName,
      builtinName: p.builtinName ?? null,
      vendor: p.vendor,
      harness: p.harness,
      description: p.description,
      stale: p.stale,
      ageMs: p.ageMs,
      evidence: p.evidence,
      exclusionReason: p.exclusionReason,
      lastCloses: p.lastCloses,
      catalog: p.catalog,
    }));
}

export function projectRecommendationResponse(s: StateSnapshot, _task = "any"): Recommendation {
  return s.recommendation;
}

