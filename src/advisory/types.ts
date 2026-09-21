import type { Quota, QuotaWire } from "../adapters/types.js";
import type { AttemptRecord } from "../store/attempts.js";
import type { CatalogStatus, CatalogView, ListedModel } from "../catalog/types.js";

/**
 * Minimum data span before a pace annualizes, in days. Under 6h a single
 * 1% quantum annualizes to 4%/day of noise — enough to fabricate Cap-risk
 * and burn-now verdicts on a fresh window. Applies to the window average
 * (elapsed time) and the recent rate (reading span) alike.
 */
export const MIN_PACE_SPAN_DAYS = 6 / 24;

export const BLEND_K = 0.5;
export const RISK_MARGIN = 0.15;
export const GATE_TOL = 0.10;

export type Urgency = "burn now" | "use soon" | "slow down" | "save" | "on track";
export type BurnStatus = "at risk" | "watch" | "on track" | "unknown";
export type PaceSource = "recent" | "window-average" | "unknown";
export type RecommendationBasis = "known-waste" | "unknown-headroom" | "none";

export type BindingWindow = "weekly" | "monthly";

export type ExclusionReason =
  | "not-reporting"
  | "stale"
  | "reset-passed"
  | "invalid"
  | "provider-failed"
  | null;

export type { AttemptRecord };

export interface Advisory {
  provider: string;
  daysLeft: number;
  remaining: number;
  idealRate: number;
  burnRate: number | null;
  recentRate?: number | null;
  baselineRate?: number | null;
  aheadOfElapsed?: boolean | null;
  /**
   * Window-average pace (used % ÷ days elapsed), always computed when the
   * window start is known — independent of `burnRate`, which is the forecast
   * input (recent 24h rolling burn when available, else this same average).
   * Surfaces show both so a flat 24h (0.0) never hides real window usage.
   */
  avgPace: number | null;
  burnMeasured: boolean;
  paceSource: PaceSource;
  daysToExhaust: number | null;
  status: BurnStatus;
  wastePct: number | null;
  urgency: Urgency;
  /** Which included window is scarcer per day left. "weekly" when there is no included monthly. */
  bindingWindow: BindingWindow;
  /** Remaining percent of the binding window. Equals `remaining` when weekly binds. */
  bindingRemaining: number;
  /** Days until the binding window resets. Equals `daysLeft` when weekly binds. */
  bindingDaysLeft: number;
}

export interface Recommendation {
  use: string;
  reason: string;
  wastePct: number | null;
  idealRate: number;
  recommendationBasis: RecommendationBasis;
  bindingWindow: BindingWindow;
  models: ListedModel[];
  catalogStatus: CatalogStatus;
  catalogFetchedAt: string | null;
  alternatives: Array<QuotaWire & { catalog: CatalogView }>;
  advisories: Advisory[];
}

export interface WindowClose {
  provider: string;
  plan: string | null;
  usedPct: number;
  leftoverPct: number;
  sampledAt: string;
  periodStart: string | null;
  resetsAt: string | null;
  resetsAtEstimated: boolean;
  detectedAt: string;
  reason: "usage-drop" | "resets-at-rolled" | "both";
}

export interface ProviderSnapshot {
  id: string;
  displayName: string;
  builtinName?: string | null;
  vendor: string | null;
  harness: string | null;
  description: string | null;
  enabled: boolean;
  quota: QuotaWire | null;
  lastAttempt: AttemptRecord | null;
  lastSuccessAt: string | null;
  reporting: boolean;
  stale: boolean;
  resetPassed: boolean;
  ageMs: number | null;
  evidence: string[];
  exclusionReason: ExclusionReason;
  advisory: Advisory | null;
  lastCloses: WindowClose[];
  catalog: CatalogView;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  upToDate: boolean;
  checkedAt: string | null;
}

export interface StateSnapshot {
  asOf: string;
  runtime: {
    available: boolean;
    ready: boolean;
    polling: "idle" | "in-progress" | "cooldown";
    lastCompletedPollAt: string | null;
    version: string;
    update?: UpdateStatus;
    /** Auth detected for these provider ids (detection-only; consumers intersect with the enabled set).
     *  Empty on daemons predating the field. */
    detectedProviders?: string[];
  };
  providers: ProviderSnapshot[];
  recommendation: Recommendation;
}
