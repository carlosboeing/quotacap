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
  /** Projected window-end position; null when pace is unknown. */
  projectedPct: number | null;
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
  let projectedPct: number | null = null;
  const advisory = provider.advisory;
  if (provider.quota && advisory && advisory.burnRate !== null && Number.isFinite(advisory.daysLeft)) {
    projectedPct = usedPct + advisory.burnRate * advisory.daysLeft;
  }
  return { usedPct, elapsedPct, projectedPct };
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

/**
 * Hatch fill for the projected-unused span. The badge colours are CSS custom
 * properties, so an alpha suffix would not parse: color-mix applies the
 * transparency instead.
 */
export function hatchGradient(badge: PaceBadge): string {
  const tint = `color-mix(in srgb, ${badgeColor(badge)} 33%, transparent)`;
  return `repeating-linear-gradient(45deg, transparent 0 3px, ${tint} 3px 5px)`;
}

export function Badge({ provider }: { provider: ProviderView }) {
  const badge = paceBadge(provider);
  const detail = exclusionDetail(provider.exclusionReason);
  return (
    <span
      data-testid="pace-badge"
      style={{
        border: `1px solid ${badgeColor(badge)}`,
        color: badgeColor(badge),
        borderRadius: 999,
        padding: "2px 8px",
        font: "var(--t-1)",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">● </span>
      {badge}
      {detail ? ` · ${detail}` : ""}
    </span>
  );
}

/**
 * Two-tier pacing rail: used fill, elapsed tick, projected-unused hatch.
 * Unknown pace shows fill and tick but no hatch and no numeric rate.
 */
export function PaceBar({ provider, asOf }: { provider: ProviderView; asOf: string }) {
  const badge = paceBadge(provider);
  const asOfMs = Date.parse(asOf);
  const { usedPct, elapsedPct, projectedPct } = barGeometry(provider, asOfMs);
  const showHatch =
    projectedPct !== null && Number.isFinite(projectedPct) && projectedPct < 100 && projectedPct > usedPct;
  const label = provider.quota
    ? `${provider.id}: ${provider.quota.usedPct}% used, ${badge}`
    : `${provider.id}: no readings, ${badge}`;
  return (
    <div data-testid="pace-bar" role="img" aria-label={label}>
      <div
        style={{
          position: "relative",
          height: 8,
          background: "var(--track)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${usedPct}%`,
            background: badgeColor(badge),
          }}
        />
        {showHatch && (
          <div
            aria-hidden="true"
            data-testid="pace-hatch"
            style={{
              position: "absolute",
              left: `${projectedPct}%`,
              top: 0,
              bottom: 0,
              right: 0,
              background: hatchGradient(badge),
            }}
          />
        )}
        {elapsedPct !== null && (
          <div
            aria-hidden="true"
            title="elapsed"
            style={{
              position: "absolute",
              left: `calc(${elapsedPct}% - 1px)`,
              top: 0,
              bottom: 0,
              width: 2,
              background: "var(--ink)",
            }}
          />
        )}
      </div>
      {elapsedPct !== null && <div style={{ font: "var(--t-1)" }}>Time elapsed: {Math.round(elapsedPct)}%</div>}
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
