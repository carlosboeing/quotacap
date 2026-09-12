import type { Quota } from "../adapters/types.js";
import type { AttemptRecord } from "../store/attempts.js";

export type Urgency = "burn now" | "use soon" | "slow down" | "save" | "on track";
export type BurnStatus = "at risk" | "on track" | "unknown";
export type PaceSource = "recent" | "window-average" | "unknown";
export type RecommendationBasis = "known-waste" | "unknown-headroom" | "none";

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
  burnMeasured: boolean;
  paceSource: PaceSource;
  daysToExhaust: number | null;
  status: BurnStatus;
  wastePct: number | null;
  urgency: Urgency;
}

export interface Recommendation {
  use: string;
  reason: string;
  wastePct: number | null;
  idealRate: number;
  recommendationBasis: RecommendationBasis;
  alternatives: any[];
  advisories: Advisory[];
}

export interface ProviderSnapshot {
  id: string;
  displayName: string;
  vendor: string | null;
  harness: string | null;
  description: string | null;
  enabled: boolean;
  quota: Quota | null;
  lastAttempt: AttemptRecord | null;
  lastSuccessAt: string | null;
  reporting: boolean;
  stale: boolean;
  resetPassed: boolean;
  ageMs: number | null;
  evidence: string[];
  exclusionReason: ExclusionReason;
  advisory: Advisory | null;
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
  };
  providers: ProviderSnapshot[];
  recommendation: Recommendation;
}
