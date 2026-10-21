import React from "react";
import type { ExclusionReason, ProviderView } from "../state.js";
import { ageDuration } from "../state.js";

export type PaceBadge = "Not reporting" | "Cap risk" | "Watch" | "Behind pace" | "Ahead of pace" | "On track" | "Measuring" | "Monthly exhausted" | "Quota exhausted";

/**
 * Pace-state badge from the mapping table. Exclusion always wins; a blocked
 * month next; otherwise status "at risk" wins, then "watch", then "unknown";
 * on-track rows ahead of cumulative elapsed time read Ahead of pace;
 * otherwise urgency decides. No client thresholds.
 */
export function paceBadge(provider: ProviderView): PaceBadge {
  if (provider.exclusionReason !== null) return "Not reporting";
  const advisory = provider.advisory;
  if (!advisory) return "Not reporting";
  if (advisory.bindingWindow === "monthly" && advisory.bindingRemaining === 0) return "Monthly exhausted";
  const quotaUsed = quotaUsedPct(provider);
  const isExhausted =
    (typeof advisory.bindingRemaining === "number" && advisory.bindingRemaining <= 0) ||
    (typeof advisory.remaining === "number" && advisory.remaining <= 0) ||
    (quotaUsed !== null && quotaUsed >= 100);
  if (isExhausted) return "Quota exhausted";
  if (advisory.status === "at risk") return "Cap risk";
  if (advisory.status === "watch") return "Watch";
  if (advisory.status === "unknown") return "Measuring";
  if (advisory.aheadOfElapsed === true) return "Ahead of pace";
  switch (advisory.urgency) {
    case "burn now":
    case "use soon":
    case "save":
      return "Behind pace";
    case "slow down":
      return "Ahead of pace";
    case "on track":
      return "On track";
  }
}

/**
 * Quota-window resolution. The advisory `bindingWindow` names the window
 * that actually rations the account (weekly for most providers, monthly
 * for OpenCode Go / Kimi when the month is scarcer). Every standalone
 * reset, pace figure, and main bar reads this window; the other windows
 * stay visible only inside Limits / the windows row as rate-limit detail.
 * Weekly-bound providers are untouched: every helper falls back to the
 * weekly fields.
 */
export function isMonthlyBound(provider: ProviderView): boolean {
  return (
    provider.advisory?.bindingWindow === "monthly" &&
    !!provider.quota?.monthlyResetsAt &&
    typeof provider.quota?.monthlyPct === "number"
  );
}

/** Reset instant of the quota window, or null without a quota reading. */
export function quotaResetsAt(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  if (isMonthlyBound(provider)) return provider.quota.monthlyResetsAt ?? null;
  return provider.quota.resetsAt ?? null;
}

/** Used percent of the quota window. Null without a quota reading. */
export function quotaUsedPct(provider: ProviderView): number | null {
  if (!provider.quota) return null;
  if (isMonthlyBound(provider)) return provider.quota.monthlyPct ?? null;
  return provider.quota.weeklyPct ?? null;
}

/** Display name of the quota window ("Monthly" / "Weekly"). */
export function quotaWindowName(provider: ProviderView): "Monthly" | "Weekly" {
  return isMonthlyBound(provider) ? "Monthly" : "Weekly";
}

/**
 * Start of the monthly window. Providers report only the monthly reset,
 * so the start is one calendar month before it (same inference the
 * drawer Limits bars use).
 */
export function monthlyWindowStartIso(resetsAt: string): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const start = new Date(resetMs);
  start.setMonth(start.getMonth() - 1);
  return start.toISOString();
}

/** Start instant of the quota window. Null when unusable. */
export function quotaWindowStartIso(provider: ProviderView): string | null {
  if (!provider.quota) return null;
  if (isMonthlyBound(provider)) {
    return provider.quota.monthlyResetsAt
      ? monthlyWindowStartIso(provider.quota.monthlyResetsAt)
      : null;
  }
  return provider.quota.periodStart ?? null;
}

/** Elapsed share (0..100) of the quota window. Null when either stamp is unusable. */
export function quotaElapsedPct(provider: ProviderView, asOfMs: number): number | null {
  const startIso = quotaWindowStartIso(provider);
  const resetIso = quotaResetsAt(provider);
  if (!startIso || !resetIso) return null;
  const startMs = Date.parse(startIso);
  const resetMs = Date.parse(resetIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetMs) || resetMs <= startMs) return null;
  if (!Number.isFinite(asOfMs)) return null;
  return Math.min(100, Math.max(0, ((asOfMs - startMs) / (resetMs - startMs)) * 100));
}

/** Even pace that lands on 100% at the quota reset: binding remaining ÷ binding days left. */
export function quotaIdealRate(
  advisory: { idealRate: number; bindingWindow?: string; bindingRemaining?: number; bindingDaysLeft?: number },
): number {
  if (
    advisory.bindingWindow === "monthly" &&
    typeof advisory.bindingRemaining === "number" &&
    typeof advisory.bindingDaysLeft === "number" &&
    advisory.bindingDaysLeft > 0
  ) {
    return advisory.bindingRemaining / advisory.bindingDaysLeft;
  }
  return advisory.idealRate;
}

/**
 * Window-average pace of the quota window. Weekly reads the server
 * `avgPace`; monthly divides the monthly used percent by the elapsed
 * monthly days. Null under a 6h span, mirroring the server minimum.
 */
export function quotaAvgPace(provider: ProviderView, asOfMs: number): number | null {
  if (!provider.quota || !provider.advisory) return null;
  if (!isMonthlyBound(provider)) return provider.advisory.avgPace ?? null;
  const used = provider.quota.monthlyPct;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const startIso = quotaWindowStartIso(provider);
  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(asOfMs)) return null;
  const elapsedDays = (asOfMs - startMs) / 86_400_000;
  if (elapsedDays < 0.25) return null;
  const pace = used / elapsedDays;
  return Number.isFinite(pace) ? Math.max(0, pace) : null;
}

/** Estimated-reset flag for the quota window; monthly resets are reported, never estimated. */
export function quotaResetEstimated(provider: ProviderView): boolean {
  if (isMonthlyBound(provider)) return false;
  if (provider.quota?.resetsAtEstimated === true) return true;
  return Array.isArray(provider.evidence)
    ? provider.evidence.includes("estimated-reset")
    : false;
}

export interface PaceFigures {
  /** Window average: used % ÷ days elapsed. Null before the window start is known. */
  avg: number | null;
  /** Recent burn: last-24h rolling rate. Null unless paceSource is "recent". */
  recent: number | null;
}

/** Split the advisory into its two displayed paces. The 24h figure is the
 * measured `recentRate`, not the blended `burnRate` forecast input; an
 * advisory from a daemon older than the blend falls back to `burnRate`,
 * which was the raw measured rate then. */
export function paceFigures(advisory: { avgPace?: number | null; burnRate: number | null; recentRate?: number | null; paceSource: string } | null | undefined): PaceFigures {
  if (!advisory) return { avg: null, recent: null };
  const avg = advisory.avgPace ?? null;
  const recent =
    advisory.recentRate !== undefined
      ? advisory.recentRate
      : advisory.paceSource === "recent"
        ? advisory.burnRate
        : null;
  return { avg, recent };
}

export interface PaceCells {
  avg: string;
  recent: string;
}

/** Card pace cells: average and 24h rate side by side, each "—" when unknown.
 * Unlike the collapsed summaries, both cells always render so the pair
 * reads as two peer figures. */
export function paceCells(advisory: { avgPace?: number | null; burnRate: number | null; recentRate?: number | null; paceSource: string } | null | undefined): PaceCells {
  const { avg, recent } = paceFigures(advisory);
  return {
    avg: avg !== null ? `${avg.toFixed(1)}%/day` : "—",
    recent: recent !== null ? `${recent.toFixed(1)}%/day` : "—",
  };
}

/**
 * Four-cell pace grid shared by the provider card and the drawer Pace
 * section, so both surfaces present the same figures the same way:
 * average pace, 24h pace, ideal pace, and time until reset. Unknown
 * figures read "—" rather than disappearing.
 */
export function PaceStats({ provider, asOf }: { provider: ProviderView; asOf: string }) {
  const asOfMs = Date.parse(asOf);
  const advisory = provider.advisory;
  const monthly = isMonthlyBound(provider);
  // Pace follows the quota window: average and ideal are quota figures,
  // and the 24h rate exists only for the weekly window (monthly history
  // is not tracked), so a monthly-bound grid reads "—" there.
  const avg = quotaAvgPace(provider, asOfMs);
  const pace = paceCells(provider.advisory);
  const ideal = advisory ? `${quotaIdealRate(advisory).toFixed(1)}%/day` : "—";
  const resetIso = quotaResetsAt(provider);
  const resetsIn = resetIso ? timeLeft(resetIso, asOfMs) : null;
  return (
    <div className="pstats">
      <div title={PACE_TIPS.avg}>
        <span className="l">Avg pace</span>
        <span className="v">{avg !== null ? `${avg.toFixed(1)}%/day` : "—"}</span>
      </div>
      <div title={PACE_TIPS.recent}>
        <span className="l">24h pace</span>
        <span className="v">{monthly ? "—" : pace.recent}</span>
      </div>
      <div title={PACE_TIPS.ideal}>
        <span className="l">Ideal pace</span>
        <span className="v">{ideal}</span>
      </div>
      <div>
        <span className="l">Resets in</span>
        <span className="v">
          {resetsIn ? `${resetsIn}${quotaResetEstimated(provider) ? " (est.)" : ""}` : resetCountdown(provider, asOfMs)}
        </span>
      </div>
    </div>
  );
}

/** Hover explanations shared by cards and rows. Plain words, no jargon. */
export const PACE_TIPS = {
  avg: "Window average — quota used ÷ days elapsed. Your overall pace this window.",
  recent: "Burn over the last 24 hours. Forecasts use this rate when recent readings exist.",
  ideal: "The even pace that lands exactly on 100% at reset: remaining ÷ days left.",
} as const;

export interface PaceLine {
  label: string;
  value: string;
  tip: string;
}

/** Table-row pace stack: one labeled line per known pace plus the needed
 * rate. Both paces always show when known (no collapsing) so rows read
 * uniformly. Empty when no advisory is present. */
export function paceLines(
  advisory: { avgPace?: number | null; burnRate: number | null; recentRate?: number | null; paceSource: string; idealRate: number; bindingWindow?: string; bindingRemaining?: number; bindingDaysLeft?: number } | null | undefined,
  provider?: ProviderView,
  asOfMs?: number,
): PaceLine[] {
  if (!advisory) return [];
  // Quota-window pace: a monthly-bound row shows the monthly average and
  // ideal; the 24h rate is weekly-only and drops out.
  const monthly = provider ? isMonthlyBound(provider) : advisory.bindingWindow === "monthly";
  const avg =
    provider && asOfMs !== undefined ? quotaAvgPace(provider, asOfMs) : (paceFigures(advisory).avg);
  const { recent } = paceFigures(advisory);
  const ideal = quotaIdealRate(advisory) ?? advisory.idealRate;
  const lines: PaceLine[] = [];
  if (avg !== null) lines.push({ label: "Avg", value: `${avg.toFixed(1)}%/day`, tip: PACE_TIPS.avg });
  if (!monthly && recent !== null) lines.push({ label: "24h", value: `${recent.toFixed(1)}%/day`, tip: PACE_TIPS.recent });
  lines.push({ label: "Ideal", value: `${ideal.toFixed(1)}%/day`, tip: PACE_TIPS.ideal });
  return lines;
}

/** Plain-words reason shown beside "Not reporting". Null when the badge says it all. */
export function exclusionDetail(reason: ExclusionReason): string | null {
  switch (reason) {
    case "stale":
      return "stale";
    case "reset-passed":
      return "reset passed";
    case "invalid":
      return "invalid";
    case "provider-failed":
      return "provider failed";
    case "not-reporting":
    case null:
      return null;
  }
}

export function isEstimated(provider: ProviderView): boolean {
  return provider.evidence.includes("estimated-reset");
}

/** Weekday plus 24h clock, e.g. "Thu 21:00". Null when unparseable. */
export function resetClock(resetsAt: string, locale?: string): string | null {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms);
  const day = when.toLocaleDateString(locale, { weekday: "short" });
  const time = when.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} ${time}`;
}

/** Weekday, calendar date and 24h clock, e.g. "Thu Oct 22 23:05". Monthly
 *  resets sit weeks out, where resetClock's weekday-only reading ("Thu 23:05")
 *  scans as this coming Thursday. Null when unparseable. */
export function resetDateClock(resetsAt: string, locale?: string): string | null {
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const when = new Date(ms);
  const day = when.toLocaleDateString(locale, { weekday: "short" });
  const date = when.toLocaleDateString(locale, { day: "numeric", month: "short" });
  const time = when.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${day} ${date} ${time}`;
}

/** Short weekday plus calendar date in the locked English copy, e.g.
 *  "Tue Sep 15". Mirrors dayOf in src/format/rows.ts, including its pinned
 *  en-US locale, so the CLI and the dashboard word the same sentence
 *  identically on any machine. */
export function resetDay(iso: string | undefined): string {
  const when = new Date(iso ?? "");
  return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${when.toLocaleDateString("en-US", { day: "numeric", month: "short" })}`;
}

/** "6d 12h" style time left from server timestamps. Null when unparseable. */
export function timeLeft(resetsAt: string, asOfMs: number): string | null {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs) || !Number.isFinite(asOfMs)) return null;
  const diffMs = resetMs - asOfMs;
  if (diffMs <= 0) return null;
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

/**
 * Days-to-duration formatter mirroring timeLeft: under 1h `Xm`, under 48h
 * `Xh Ym`, at 48h+ `Xd Xh`. Hours in the days branch round to the nearest
 * hour so 2.4d reads "2d 10h".
 */
export function daysToDuration(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "0m";
  const totalMinutes = Math.round(days * 24 * 60);
  if (totalMinutes < 60) return `${Math.max(1, totalMinutes)}m`;
  if (totalMinutes < 48 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  let d = Math.floor(totalMinutes / (24 * 60));
  const remainderMinutes = totalMinutes - d * 24 * 60;
  let h = Math.round(remainderMinutes / 60);
  if (h === 24) {
    d += 1;
    h = 0;
  }
  return `${d}d ${h}h`;
}

export const formatDurationDays = daysToDuration;
export const durationFromDays = daysToDuration;

/**
 * Reset rendering for a row. Estimated resets carry "(est.)"; reset-passed
 * rows await a fresh window; invalid rows carry a row-level note.
 */
export function resetCountdown(provider: ProviderView, asOfMs: number): string {
  if (provider.exclusionReason === "reset-passed") return "awaiting fresh window";
  if (!provider.quota) return "no readings";
  const resetIso = quotaResetsAt(provider);
  if (!resetIso) return "no readings";
  const left = timeLeft(resetIso, asOfMs);
  if (left === null) {
    const resetMs = Date.parse(resetIso);
    if (Number.isFinite(resetMs) && resetMs <= asOfMs) return "awaiting fresh window";
    return "reset unknown";
  }
  const estimated = quotaResetEstimated(provider) ? " (est.)" : "";
  return `in ${left}${estimated}`;
}

export interface ResetCellLines {
  /** Clock line ("Thu 16:53"), or the whole wording when single-line. */
  top: string;
  /** Countdown line ("in 2d 17h"), or null for single-line states. */
  bottom: string | null;
}

/**
 * Reset cell for the table view as two stacked lines: the clock on top,
 * the countdown below. Estimated resets mark the timestamp, per the 0.0.25
 * convention. Reset-passed, missing, and unparseable rows stay single-line.
 */
export function resetCellLines(provider: ProviderView, asOfMs: number): ResetCellLines {
  if (provider.exclusionReason === "reset-passed") return { top: "awaiting fresh window", bottom: null };
  if (!provider.quota) return { top: "no readings", bottom: null };
  const resetIso = quotaResetsAt(provider);
  if (!resetIso) return { top: "no readings", bottom: null };
  // A monthly quota reset sits weeks out: it carries the calendar date,
  // where the weekly clock's weekday alone would read as this week.
  const clock = isMonthlyBound(provider) ? resetDateClock(resetIso) : resetClock(resetIso);
  const left = timeLeft(resetIso, asOfMs);
  const estimated = quotaResetEstimated(provider) ? " (est.)" : "";
  if (clock && left) return { top: `${clock}${estimated}`, bottom: `in ${left}` };
  if (left === null) {
    const resetMs = Date.parse(resetIso);
    if (Number.isFinite(resetMs) && resetMs <= asOfMs) return { top: "awaiting fresh window", bottom: null };
    return { top: "reset unknown", bottom: null };
  }
  return { top: "reset unknown", bottom: null };
}

/**
 * Single-line reset wording, e.g. "Tue 10:25 · in 20h 30m". Same content
 * as resetCellLines, joined for compact contexts.
 */
export function resetCell(provider: ProviderView, asOfMs: number): string {
  const { top, bottom } = resetCellLines(provider, asOfMs);
  return bottom ? `${top} · ${bottom}` : top;
}

export interface BarGeometry {
  usedPct: number;
  elapsedPct: number | null;
}

/** Bar geometry of the quota window from server timestamps and percents. Presentation only. */
export function barGeometry(provider: ProviderView, asOfMs: number): BarGeometry {
  const usedRaw = quotaUsedPct(provider);
  const usedPct = usedRaw !== null ? Math.min(100, Math.max(0, usedRaw)) : 0;
  const elapsedPct = quotaElapsedPct(provider, asOfMs);
  return { usedPct, elapsedPct };
}

export function badgeColor(badge: PaceBadge): string {
  switch (badge) {
    case "On track":
      return "var(--good)";
    case "Behind pace":
      return "var(--warn)";
    case "Ahead of pace":
      return "var(--ahead)";
    case "Watch":
      return "var(--watch)";
    case "Quota exhausted":
    case "Monthly exhausted":
    case "Cap risk":
      return "var(--danger)";
    case "Measuring":
      return "var(--ink-soft)";
    case "Not reporting":
      return "var(--line-strong)";
  }
}

export function fillToken(badge: PaceBadge): string {
  switch (badge) {
    case "On track":
      return "var(--fill-ontrack)";
    case "Behind pace":
      return "var(--fill-behind)";
    case "Ahead of pace":
      return "var(--fill-ahead)";
    case "Watch":
      return "var(--fill-watch)";
    case "Quota exhausted":
    case "Monthly exhausted":
    case "Cap risk":
      return "var(--fill-cap)";
    case "Measuring":
      return "var(--fill-out)";
    case "Not reporting":
      return "var(--fill-out)";
  }
}

export function edgeToken(badge: PaceBadge): string {
  switch (badge) {
    case "On track":
      return "var(--edge-ontrack)";
    case "Behind pace":
      return "var(--edge-behind)";
    case "Ahead of pace":
      return "var(--edge-ahead)";
    case "Watch":
      return "var(--edge-watch)";
    case "Quota exhausted":
    case "Monthly exhausted":
    case "Cap risk":
      return "var(--edge-cap)";
    case "Measuring":
      return "var(--edge-out)";
    case "Not reporting":
      return "var(--edge-out)";
  }
}

export function outKind(badge: PaceBadge): "behind" | "watch" | "cap" | "ontrack" | "none" {
  switch (badge) {
    case "Behind pace":
      return "behind";
    case "Watch":
      return "watch";
    case "Quota exhausted":
    case "Monthly exhausted":
    case "Cap risk":
      return "cap";
    case "On track":
      return "ontrack";
    default:
      return "none";
  }
}

/**
 * Hatch fill for unused quota. Ink mix (not an alpha suffix on a custom
 * property) so the browser always paints a gradient.
 */
export function hatchGradient(_badge?: PaceBadge): string {
  return "repeating-linear-gradient(45deg, color-mix(in oklch, var(--ink) 20%, transparent) 0 1.5px, transparent 1.5px 7px)";
}

/**
 * Badge hover copy: red and amber explain the verdict; an estimated reset is
 * confessed on the end. Other badges read their own label and need no title.
 */
export function badgeTitle(badge: PaceBadge, estimated: boolean): string | undefined {
  let title: string | undefined;
  if (badge === "Quota exhausted") {
    title = "Quota fully used until reset";
  } else if (badge === "Monthly exhausted") {
    title = "Monthly quota fully used until reset";
  } else if (badge === "Cap risk") {
    title = "Burning faster than the window allows and ahead of elapsed time";
  } else if (badge === "Watch") {
    title = "Pace points at the cap, but position or the reset clock is uncertain";
  }
  if (title && estimated) title += " (estimated reset)";
  return title;
}

export function Badge({
  provider,
  compact = false,
}: {
  provider: ProviderView;
  /** Compact drops the exclusion detail from the label into the tooltip. */
  compact?: boolean;
}) {
  const badge = paceBadge(provider);
  const detail = exclusionDetail(provider.exclusionReason);
  const badgeClass =
    badge === "Behind pace"
      ? "pace-behind"
      : badge === "On track"
      ? "pace-ontrack"
      : badge === "Ahead of pace"
      ? "pace-ahead"
      : badge === "Watch"
      ? "pace-watch"
      : badge === "Cap risk" || badge === "Monthly exhausted" || badge === "Quota exhausted"
      ? "pace-cap"
      : "pace-out"; // Not reporting and Measuring share the neutral style
  const title =
    compact && detail
      ? `${badge} · ${detail}`
      : badgeTitle(badge, quotaResetEstimated(provider));
  return (
    <span data-testid="pace-badge" className={`pace ${badgeClass}`} title={title}>
      {badge}
      {!compact && detail ? ` · ${detail}` : ""}
    </span>
  );
}

export type PaceHeadlineKind = "behind" | "watch" | "cap" | "ontrack" | "none";

export interface PaceHeadline {
  text: string;
  kind: PaceHeadlineKind;
  /** True when the projected-unused hatch belongs on the bar. */
  hatch: boolean;
}

export function isQuotaExhaustedBeforeReset(provider: ProviderView, asOfMs?: number): boolean {
  if (provider.resetPassed) return false;
  const resetIso = quotaResetsAt(provider);
  if (!resetIso) return false;
  const resetMs = Date.parse(resetIso);
  if (Number.isFinite(resetMs) && asOfMs !== undefined && resetMs <= asOfMs) return false;
  const used = quotaUsedPct(provider);
  if (used !== null && used >= 100) return true;
  if (isMonthlyBound(provider) && provider.quota?.monthlyStatus === "exhausted") return true;
  return false;
}

/**
 * Headline forecast shared by the card bar and the drawer quota row:
 * "expires unused" wording when a waste hatch applies, otherwise the
 * one-line forecast. Null when there is nothing to forecast.
 */
export function paceHeadline(provider: ProviderView, asOfMs?: number): PaceHeadline | null {
  const badge = paceBadge(provider);
  const monthlyBinds = provider.advisory?.bindingWindow === "monthly";
  const wastePct = provider.advisory?.wastePct;
  const hatch =
    !monthlyBinds && wastePct !== null && wastePct !== undefined && Number.isFinite(wastePct) && wastePct >= 3;
  const is100Exhausted = isQuotaExhaustedBeforeReset(provider, asOfMs);
  if (provider.exclusionReason !== null && is100Exhausted) {
    const line = forecastLine(provider);
    return {
      text: line ? `Exhausted · ${line}` : "Exhausted · quota fully used",
      kind: "cap",
      hatch: false,
    };
  }
  const text =
    hatch && badge === "Behind pace" ? `${Math.round(wastePct!)}% expires unused` : forecastLine(provider);
  if (!text) return null;
  const kind: PaceHeadlineKind = monthlyBinds
    ? provider.advisory!.bindingRemaining === 0
      ? "cap"
      : "behind"
    : outKind(badge);
  return { text, kind, hatch };
}

/**
 * Two-tier pacing rail: used fill, elapsed tick, projected-unused hatch.
 * Unknown pace shows fill and tick but no hatch and no numeric rate.
 */
export function PaceBar({
  provider,
  asOf,
  showHeadline = true,
}: {
  provider: ProviderView;
  asOf: string;
  showHeadline?: boolean;
}) {
  const badge = paceBadge(provider);
  const asOfMs = Date.parse(asOf);
  const { usedPct, elapsedPct } = barGeometry(provider, asOfMs);
  const wastePct = provider.advisory?.wastePct;
  const headline = paceHeadline(provider, asOfMs);
  // A weekly-sized hatch under a month-bound card restates issue 109.
  const showHatch = headline?.hatch ?? false;
  const quotaUsed = quotaUsedPct(provider);
  const label = provider.quota
    ? `${provider.id}: ${quotaUsed ?? provider.quota.weeklyPct}% used, ${badge}`
    : `${provider.id}: no readings, ${badge}`;
  const is100Exhausted = isQuotaExhaustedBeforeReset(provider, asOfMs);
  const fillBg = is100Exhausted ? "var(--fill-cap)" : fillToken(badge);
  const edgeBg = is100Exhausted ? "var(--edge-cap)" : edgeToken(badge);
  return (
    <div data-testid="pace-bar" role="img" aria-label={label} className="trackwrap">
      {showHeadline && provider.quota && (
        <div className="tline">
          <span className="used">{quotaUsed ?? provider.quota.weeklyPct}% used</span>
          {headline && headline.kind !== "none" ? (
            <span className={`out out-${headline.kind}`}>→ {headline.text}</span>
          ) : headline ? (
            <span className="out out-none">→ {headline.text}</span>
          ) : null}
        </div>
      )}
      <div className="track">
        <div
          aria-hidden="true"
          className="fill"
          style={{
            width: `${usedPct}%`,
            background: fillBg,
            ["--fill-edge" as string]: edgeBg,
          }}
        />
        {showHatch && (
          <div
            aria-hidden="true"
            data-testid="pace-hatch"
            className="band band-waste"
            style={{
              left: `${100 - wastePct!}%`,
              width: `${wastePct}%`,
            }}
          />
        )}
        {elapsedPct !== null && (
          <div
            aria-hidden="true"
            title="elapsed"
            className="mark"
            style={{
              left: `${elapsedPct}%`,
            }}
          />
        )}
      </div>
      <div className="tfoot">
        <span>start</span>
        <span>{elapsedPct !== null ? `Time elapsed: ${Math.round(elapsedPct)}%` : ""}</span>
        <span>reset</span>
      </div>
    </div>
  );
}

/** One-line forecast from server fields. Unknown pace shows no rate or waste. */
export function forecastLine(provider: ProviderView): string | null {
  if (provider.exclusionReason === "not-reporting" || !provider.quota) return "Not reporting yet.";
  switch (provider.exclusionReason) {
    case "stale": {
      const age = ageDuration(provider.ageMs);
      return age ? `Stale. Last read ${age} ago.` : "Stale. Last read unknown.";
    }
    case "reset-passed":
      return "Reset passed. Awaiting fresh window.";
    case "invalid":
      return "Reading invalid. Excluded from ranking.";
    case "provider-failed":
      return "Provider failed. Excluded from ranking.";
  }
  const advisory = provider.advisory;
  if (!advisory) return null;
  if (advisory.bindingWindow === "monthly" && advisory.bindingRemaining <= 0) {
    return `unused until ${resetDay(provider.quota.monthlyResetsAt)}`;
  }
  if (advisory.bindingWindow === "monthly") {
    return `${Math.round(advisory.bindingRemaining)}% of month left`;
  }
  if (advisory.remaining <= 0) {
    return "Exhausted · quota fully used";
  }
  if (advisory.paceSource === "unknown") {
    return `Measuring pace · ${Math.round(advisory.remaining)}% remaining`;
  }
  if (advisory.status === "at risk") {
    return advisory.daysToExhaust !== null && Number.isFinite(advisory.daysToExhaust)
      ? `Cap risk · exhausts in ${daysToDuration(advisory.daysToExhaust)} at current pace`
      : "Cap risk at current pace";
  }
  if (advisory.status === "watch") {
    return advisory.daysToExhaust !== null && Number.isFinite(advisory.daysToExhaust)
      ? `Watch · exhausts in ${daysToDuration(advisory.daysToExhaust)} at current pace`
      : "Watch at current pace";
  }
  if (advisory.wastePct !== null) {
    return `${Math.round(advisory.wastePct)}% waste in ${daysToDuration(advisory.daysLeft)}`;
  }
  return "On track.";
}
