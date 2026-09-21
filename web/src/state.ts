// Vendored view of Track A's StateSnapshot contract (src/advisory/types.ts).
//
// The web bundle cannot import Node-only src/ modules, so these types mirror
// A's shapes field-for-field. Mapping is presentation only: server words and
// flags pass through untouched. Staleness, ranking, waste, pace labels, and
// freshness are never recomputed here.

export type Urgency = "burn now" | "use soon" | "slow down" | "save" | "on track";
export type BurnStatus = "at risk" | "watch" | "on track" | "unknown";
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
  /** Measured 24h rolling rate; absent on advisories from a daemon older than the blend. */
  recentRate?: number | null;
  /** History-anchored baseline feeding the blend; null when unavailable. */
  baselineRate?: number | null;
  /** Cumulative position versus elapsed time; null on excluded/unknown branches. */
  aheadOfElapsed?: boolean | null;
  /** Window-average pace (used % ÷ days elapsed); null before the window start is known. */
  avgPace: number | null;
  burnMeasured: boolean;
  paceSource: PaceSource;
  daysToExhaust: number | null;
  status: BurnStatus;
  wastePct: number | null;
  urgency: Urgency;
  bindingWindow: "weekly" | "monthly";
  bindingRemaining: number;
  bindingDaysLeft: number;
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

export interface WindowCloseView {
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

export interface QuotaView {
  provider: string;
  plan: string;
  weeklyPct: number;
  fiveHourPct?: number;
  monthlyPct?: number;
  monthlyResetsAt?: string;
  monthlyStatus?: "ok" | "exhausted";
  monthlyKind?: "included";
  /** @deprecated wire alias for weeklyPct. */
  usedPct: number;
  /** @deprecated wire alias for fiveHourPct. */
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
  diagnosticCode?: string | null;
  summary?: string | null;
  action?: string | null;
  errorDetail?: string | null;
  error?: string | null;
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
  lastCloses: WindowCloseView[];
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
  detectedProviders?: string[];
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
        lastCloses: Array.isArray(p.lastCloses) ? [...p.lastCloses] : [],
      }))
    : [];
  const advisories = Array.isArray(s.recommendation?.advisories)
    ? [...s.recommendation.advisories]
    : [];
  return {
    asOf: s.asOf,
    runtime: {
      ...s.runtime,
      // A service older than opencode-go support omits this field.
      detectedProviders: Array.isArray((s.runtime as RuntimeView | undefined)?.detectedProviders)
        ? [...(s.runtime.detectedProviders as string[])]
        : [],
    },
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

/** Plan for display. Vendors that expose no tier report "unknown", which never renders. */
export function displayPlan(plan: string | null | undefined): string | null {
  if (!plan || plan === "unknown") return null;
  return plan;
}

/**
 * Short-window display name ("5h Limit"). Codex, Kimi, and Agy report a 5h limit;
 * Claude (current session) and Muse (current window) report an equivalent 5-hour
 * rolling window, as does OpenCode Go. Returns null when the provider reports no
 * short window (grok, manual).
 */
export function shortWindowLabel(id: string): string | null {
  switch (id.split(":")[0]) {
    case "codex":
    case "kimi":
    case "agy":
    case "claude":
    case "muse":
    case "opencode-go":
      return "5h Limit";
    default:
      return null;
  }
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
