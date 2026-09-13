import React from "react";
import type { ExclusionReason, ProviderView } from "../state.js";
import { ageDuration } from "../state.js";

export type PaceBadge = "Not reporting" | "Cap risk" | "Behind pace" | "Ahead of pace" | "On track";

/**
 * Pace-state badge from the mapping table. Exclusion always wins; otherwise
 * status "at risk" wins; otherwise urgency decides. No client thresholds.
 */
export function paceBadge(provider: ProviderView): PaceBadge {
  if (provider.exclusionReason !== null) return "Not reporting";
  const advisory = provider.advisory;
  if (!advisory) return "Not reporting";
  if (advisory.status === "at risk") return "Cap risk";
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

export interface PaceFigures {
  /** Window average: used % ÷ days elapsed. Null before the window start is known. */
  avg: number | null;
  /** Recent burn: last-24h rolling rate. Null unless paceSource is "recent". */
  recent: number | null;
}

/** Split the advisory into its two displayed paces. `burnRate` doubles as the
 * forecast input, so the recent figure only exists when it was measured. */
export function paceFigures(advisory: { avgPace?: number | null; burnRate: number | null; paceSource: string } | null | undefined): PaceFigures {
  if (!advisory) return { avg: null, recent: null };
  const avg = advisory.avgPace ?? null;
  const recent = advisory.paceSource === "recent" ? advisory.burnRate : null;
  return { avg, recent };
}

export interface PaceCell {
  primary: string;
  secondary: string | null;
}

/** Card pace cell: window average first, 24h rate beneath it. A pair that
 * renders identically at display precision collapses to one figure. */
export function paceCell(advisory: { avgPace?: number | null; burnRate: number | null; paceSource: string } | null | undefined): PaceCell {
  const { avg, recent } = paceFigures(advisory);
  if (avg !== null && recent !== null && avg.toFixed(1) !== recent.toFixed(1)) {
    return { primary: `${avg.toFixed(1)}%/day`, secondary: `24h ${recent.toFixed(1)}%/day` };
  }
  if (avg !== null) return { primary: `${avg.toFixed(1)}%/day`, secondary: null };
  if (recent !== null) return { primary: `${recent.toFixed(1)}%/day`, secondary: "24h rate" };
  return { primary: "—", secondary: null };
}

/** One-line pace summary for table rows. Null when no pace is known. */
export function paceSummary(advisory: { avgPace?: number | null; burnRate: number | null; paceSource: string } | null | undefined): string | null {
  const { avg, recent } = paceFigures(advisory);
  if (avg !== null && recent !== null && avg.toFixed(1) !== recent.toFixed(1)) {
    return `Avg ${avg.toFixed(1)}%/day · 24h ${recent.toFixed(1)}%/day`;
  }
  if (avg !== null) return `Avg ${avg.toFixed(1)}%/day`;
  if (recent !== null) return `24h ${recent.toFixed(1)}%/day`;
  return null;
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

const EVIDENCE_LABELS: Record<string, string> = {
  measured: "Measured",
  "window-average": "Window avg",
};

/** Coordinator-locked evidence labels. Unknown tokens pass through verbatim. */
export function evidenceLabels(evidence: string[]): string[] {
  return evidence
    .filter((e) => e !== "estimated-reset")
    .map((e) => EVIDENCE_LABELS[e] ?? e);
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
 * Reset rendering for a row. Estimated resets carry "(est.)"; reset-passed
 * rows await a fresh window; invalid rows carry a row-level note.
 */
export function resetCountdown(provider: ProviderView, asOfMs: number): string {
  if (provider.exclusionReason === "reset-passed") return "awaiting fresh window";
  if (!provider.quota) return "no readings";
  const left = timeLeft(provider.quota.resetsAt, asOfMs);
  if (left === null) {
    const resetMs = Date.parse(provider.quota.resetsAt);
    if (Number.isFinite(resetMs) && resetMs <= asOfMs) return "awaiting fresh window";
    return "reset unknown";
  }
  const estimated = isEstimated(provider) ? " (est.)" : "";
  return `in ${left}${estimated}`;
}

export interface BarGeometry {
  usedPct: number;
  elapsedPct: number | null;
}

/** Bar geometry from server timestamps and percents. Presentation only. */
export function barGeometry(provider: ProviderView, asOfMs: number): BarGeometry {
  const usedPct = provider.quota ? Math.min(100, Math.max(0, provider.quota.usedPct)) : 0;
  let elapsedPct: number | null = null;
  if (provider.quota) {
    const startMs = Date.parse(provider.quota.periodStart);
    const resetMs = Date.parse(provider.quota.resetsAt);
    if (Number.isFinite(startMs) && Number.isFinite(resetMs) && resetMs > startMs) {
      elapsedPct = Math.min(1, Math.max(0, (asOfMs - startMs) / (resetMs - startMs))) * 100;
    }
  }
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
    case "Cap risk":
      return "var(--danger)";
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
    case "Cap risk":
      return "var(--fill-cap)";
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
    case "Cap risk":
      return "var(--edge-cap)";
    case "Not reporting":
      return "var(--edge-out)";
  }
}

export function outKind(badge: PaceBadge): "behind" | "cap" | "ontrack" | "none" {
  switch (badge) {
    case "Behind pace":
      return "behind";
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

export function Badge({ provider }: { provider: ProviderView }) {
  const badge = paceBadge(provider);
  const detail = exclusionDetail(provider.exclusionReason);
  const badgeClass =
    badge === "Behind pace"
      ? "pace-behind"
      : badge === "On track"
      ? "pace-ontrack"
      : badge === "Ahead of pace"
      ? "pace-ahead"
      : badge === "Cap risk"
      ? "pace-cap"
      : "pace-out";
  return (
    <span
      data-testid="pace-badge"
      className={`pace ${badgeClass}`}
    >
      {badge}
      {detail ? ` · ${detail}` : ""}
    </span>
  );
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
  const showHatch =
    wastePct !== null && wastePct !== undefined && Number.isFinite(wastePct) && wastePct >= 3;
  const label = provider.quota
    ? `${provider.id}: ${provider.quota.usedPct}% used, ${badge}`
    : `${provider.id}: no readings, ${badge}`;
  const forecast =
    showHatch && badge === "Behind pace" ? `${Math.round(wastePct!)}% expires unused` : forecastLine(provider);
  const kind = outKind(badge);
  return (
    <div data-testid="pace-bar" role="img" aria-label={label} className="trackwrap">
      {showHeadline && provider.quota && (
        <div className="tline">
          <span className="used">{provider.quota.usedPct}% used</span>
          {forecast && kind !== "none" ? (
            <span className={`out out-${kind}`}>→ {forecast}</span>
          ) : forecast ? (
            <span className="out out-none">→ {forecast}</span>
          ) : null}
        </div>
      )}
      <div className="track">
        <div
          aria-hidden="true"
          className="fill"
          style={{
            width: `${usedPct}%`,
            background: fillToken(badge),
            ["--fill-edge" as string]: edgeToken(badge),
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
  if (advisory.remaining <= 0) {
    return "Exhausted · quota fully used";
  }
  if (advisory.paceSource === "unknown") {
    return `Measuring pace · ${Math.round(advisory.remaining)}% remaining`;
  }
  if (advisory.status === "at risk") {
    return advisory.daysToExhaust !== null && Number.isFinite(advisory.daysToExhaust)
      ? `Cap risk · exhausts in ${advisory.daysToExhaust.toFixed(1)}d at current pace`
      : "Cap risk at current pace";
  }
  if (advisory.wastePct !== null) {
    return `${Math.round(advisory.wastePct)}% waste in ${advisory.daysLeft.toFixed(1)}d`;
  }
  return "On track.";
}
