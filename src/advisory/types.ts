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

/** Weekly quota window. "Far from reset" in the on-track tube is this long. */
export const PACE_WINDOW_DAYS = 7;

/**
 * Narrowest on-track tube, as a fraction of the time still left. At the
 * reset, a finish within 5% of it still reads on track.
 */
export const TUBE_FLOOR = 0.05;

/**
 * Half-width of the on-track tube, as a fraction of `daysLeft`.
 *
 * The tube grows from `TUBE_FLOOR` at the reset to `margin` once about 4.7
 * days remain, and never wider than `margin`. A forecast inside it is close
 * enough to a full finish to read on track. The shell between the tube and
 * `margin` stays Watch, so a small miss still warns near the reset. Cap risk
 * stays outside `margin` on the early side.
 */
export function paceTube(daysLeft: number, margin = RISK_MARGIN): number {
  if (!(daysLeft > 0) || !(margin > 0)) return TUBE_FLOOR;
  const grown = TUBE_FLOOR + margin * (daysLeft / PACE_WINDOW_DAYS);
  return Math.min(margin, grown);
}

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
   * True when the forecast finish sits inside the horizon tube around the
   * reset and the verdict is on track. The badge stays On track even if
   * usage is slightly ahead of elapsed time. False for a clear leftover,
   * a Watch shell, and an estimated clock.
   */
  closeToReset: boolean;
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
  /** ISO timestamp when the binding quota reached 100% in this window, or null if not exhausted. */
  exhaustedAt?: string | null;
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
    /** Login command for the locally detected OpenCode CLI version, or
     *  null when the version could not be read. */
    opencodeLoginCommand?: string | null;
  };
  providers: ProviderSnapshot[];
  recommendation: Recommendation;
}
