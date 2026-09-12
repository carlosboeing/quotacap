// Vendored view of Track A's StateSnapshot contract (src/advisory/types.ts).
//
// The web bundle cannot import Node-only src/ modules, so these types mirror
// A's shapes field-for-field. Mapping is presentation only: server words and
// flags pass through untouched. Staleness, ranking, waste, pace labels, and
// freshness are never recomputed here.

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

export interface AdvisoryView {
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

export interface RecommendationView {
  use: string;
  reason: string;
  wastePct: number | null;
  idealRate: number;
  recommendationBasis: RecommendationBasis;
  alternatives: unknown[];
  advisories: AdvisoryView[];
}

export interface QuotaView {
  provider: string;
  plan: string;
  usedPct: number;
  sessionPct?: number;
  resetsAt: string;
  periodStart: string;
  source: string;
  fetchedAt: string;
  creditsUsd?: number;
  resetsAtEstimated?: boolean;
}

export type FailureCategory = "timeout" | "auth" | "parse" | "network" | "skipped" | "unknown" | null;

export interface AttemptView {
  provider: string;
  attemptedAt: string;
  completedAt: string | null;
  succeededAt: string | null;
  success: boolean;
  failureCategory: FailureCategory;
}

export interface ProviderView {
  id: string;
  displayName: string;
  builtinName: string | null;
  vendor: string | null;
  harness: string | null;
  description: string | null;
  enabled: boolean;
  quota: QuotaView | null;
  lastAttempt: AttemptView | null;
  lastSuccessAt: string | null;
  reporting: boolean;
  stale: boolean;
  resetPassed: boolean;
  ageMs: number | null;
  evidence: string[];
  exclusionReason: ExclusionReason;
  advisory: AdvisoryView | null;
}

export interface UpdateView {
  current: string;
  latest: string | null;
  upToDate: boolean;
  checkedAt: string | null;
}

export interface RuntimeView {
  available: boolean;
  ready: boolean;
  polling: "idle" | "in-progress" | "cooldown";
  lastCompletedPollAt: string | null;
  version: string;
  update?: UpdateView;
}

export interface StateSnapshot {
  asOf: string;
  runtime: RuntimeView;
  providers: ProviderView[];
  recommendation: RecommendationView;
}

export interface ViewModel {
  asOf: string;
  runtime: RuntimeView;
  providers: ProviderView[];
  recommendation: RecommendationView;
}

/** Pass-through with null guards. Server words and flags are never altered. */
export function toViewModel(s: StateSnapshot): ViewModel {
  const providers = Array.isArray(s.providers)
    ? s.providers.map((p) => ({
        ...p,
        // A service older than the naming standard omits these four.
        displayName: typeof p.displayName === "string" && p.displayName ? p.displayName : p.id,
        builtinName: p.builtinName ?? null,
        vendor: p.vendor ?? null,
        harness: p.harness ?? null,
        description: p.description ?? null,
        evidence: Array.isArray(p.evidence) ? [...p.evidence] : [],
      }))
    : [];
  const advisories = Array.isArray(s.recommendation?.advisories)
    ? [...s.recommendation.advisories]
    : [];
  return {
    asOf: s.asOf,
    runtime: { ...s.runtime },
    providers,
    recommendation: { ...s.recommendation, advisories },
  };
}

/** First run means no stored quota rows at all. Stale rows are still rows. */
export function firstRun(s: { providers: Array<{ quota: unknown }> }): boolean {
  return s.providers.every((p) => p.quota === null || p.quota === undefined);
}

/**
 * Drawer/tooltip subtitle. Derived, never authored: when the harness name
 * repeats the display name ("Antigravity · Google" would stutter), only the
 * vendor shows. Null when neither is registered.
 */
export function providerSubtitle(
  p: Pick<ProviderView, "displayName" | "vendor" | "harness">
): string | null {
  if (!p.harness && !p.vendor) return null;
  if (p.harness && p.vendor && p.harness === p.displayName) return p.vendor;
  return [p.harness, p.vendor].filter(Boolean).join(" · ");
}

/** "read Xm ago" from the last good snapshot's server timestamp. */
export function ageLabel(asOf: string, nowMs: number = Date.now()): string {
  const diff = nowMs - Date.parse(asOf);
  if (!Number.isFinite(diff) || diff < 1000) return "read just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `read ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `read ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `read ${hours}h ago`;
  return `read ${Math.floor(hours / 24)}d ago`;
}

/** Default poll interval; matches `pollMinutes` in `src/config.ts`. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;

/** Health-strip copy for the next scheduled poll. */
export function nextRefreshLabel(
  lastCompletedPollAt: string | null,
  polling: RuntimeView["polling"],
  nowMs: number = Date.now(),
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): string {
  if (polling === "in-progress") return "Refreshing now";
  if (!lastCompletedPollAt) return "Next automatic refresh pending";
  const last = Date.parse(lastCompletedPollAt);
  if (!Number.isFinite(last)) return "Next automatic refresh pending";
  const remaining = intervalMs - (nowMs - last);
  if (remaining <= 0) return "Next automatic refresh due";
  const minutes = Math.max(1, Math.round(remaining / 60_000));
  if (minutes < 60) return `Next automatic refresh in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `Next automatic refresh in ${hours}h`
    : `Next automatic refresh in ${hours}h ${rest}m`;
}

/** "1h 30m" style duration for a last-read age in milliseconds. */
export function ageDuration(ageMs: number | null): string | null {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
