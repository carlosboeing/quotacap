import React from "react";
import type { ProviderView } from "../state.js";
import {
  PACE_TIPS,
  PaceStats,
  barGeometry,
  isMonthlyBound,
  paceBadge,
  paceFigures,
  quotaAvgPace,
  quotaResetsAt,
  quotaWindowName,
  quotaWindowStartIso,
} from "./PaceBar.js";

export type BurnTone = "cap" | "behind" | "ontrack";

/** Chart tone from the shared badge: cap risk paints cap, behind-pace paints
 * behind, and on-track/ahead share the ontrack tone on the ahead token. */
export function burnTone(provider: ProviderView): BurnTone {
  const badge = paceBadge(provider);
  switch (badge) {
    case "Quota exhausted":
    case "Cap risk":
    case "Monthly exhausted":
    case "Watch":
      return "cap";
    case "Behind pace":
      return "behind";
    default:
      return "ontrack";
  }
}

export interface BurnGeometry {
  usedPct: number;
  elapsedPct: number;
  projXPct: number;
  projYPct: number;
  exhaustsBeforeReset: boolean;
  tone: BurnTone;
}

/**
 * Burn-down geometry in quota-window data space (x = elapsed %, y = used %).
 * Actual runs (0,0) to (elapsed, used); projection ends at 100% when
 * exhaustion precedes the quota reset, else at (100, used + rate × days
 * left). Weekly projects at the server burn rate; monthly projects at the
 * monthly window average (no monthly burn history is tracked). Null when
 * the quota pace is unknown.
 */
export function burnGeometry(provider: ProviderView, asOfMs: number): BurnGeometry | null {
  if (!provider.quota || !provider.advisory) return null;
  if (provider.exclusionReason !== null) return null;
  const advisory = provider.advisory;
  const monthly = isMonthlyBound(provider);
  let burnRate: number | null;
  let daysLeft: number;
  let daysToExhaust: number | null;
  if (monthly) {
    burnRate = quotaAvgPace(provider, asOfMs);
    daysLeft = advisory.bindingDaysLeft;
    daysToExhaust =
      burnRate !== null && burnRate > 0 ? advisory.bindingRemaining / burnRate : Infinity;
  } else {
    if (advisory.paceSource === "unknown") return null;
    burnRate = advisory.burnRate;
    daysLeft = advisory.daysLeft;
    daysToExhaust = advisory.daysToExhaust;
  }
  if (burnRate === null || !Number.isFinite(burnRate)) return null;
  const { usedPct, elapsedPct } = barGeometry(provider, asOfMs);
  if (elapsedPct === null || !Number.isFinite(elapsedPct)) return null;
  let projXPct: number;
  let projYPct: number;
  let exhaustsBeforeReset = false;
  if (
    daysToExhaust !== null &&
    Number.isFinite(daysToExhaust) &&
    daysToExhaust < daysLeft
  ) {
    exhaustsBeforeReset = true;
    projYPct = 100;
    if (usedPct >= 100) {
      projXPct = elapsedPct;
    } else {
      const startIso = quotaWindowStartIso(provider);
      const resetIso = quotaResetsAt(provider);
      const startMs = startIso ? Date.parse(startIso) : NaN;
      const resetMs = resetIso ? Date.parse(resetIso) : NaN;
      if (
        Number.isFinite(startMs) &&
        Number.isFinite(resetMs) &&
        resetMs > startMs &&
        Number.isFinite(asOfMs)
      ) {
        const totalDays = (resetMs - startMs) / 86_400_000;
        const elapsedDays = (asOfMs - startMs) / 86_400_000;
        projXPct = ((elapsedDays + daysToExhaust) / totalDays) * 100;
      } else if (elapsedPct < 100 && daysLeft > 0) {
        projXPct = elapsedPct + (daysToExhaust * (100 - elapsedPct)) / daysLeft;
      } else {
        projXPct = 100;
      }
      projXPct = Math.min(100, Math.max(elapsedPct, projXPct));
    }
  } else {
    projXPct = 100;
    projYPct = usedPct + burnRate * daysLeft;
    if (!Number.isFinite(projYPct)) projYPct = usedPct;
    projYPct = Math.min(100, Math.max(usedPct, projYPct));
  }
  return {
    usedPct,
    elapsedPct,
    projXPct,
    projYPct,
    exhaustsBeforeReset,
    tone: burnTone(provider),
  };
}

export function burnAriaLabel(provider: ProviderView, geo: BurnGeometry): string {
  const used = Math.round(geo.usedPct);
  const elapsed = Math.round(geo.elapsedPct);
  const window = `${quotaWindowName(provider).toLowerCase()} quota window`;
  if (geo.exhaustsBeforeReset) {
    return `Burn-down: ${used} percent used at ${elapsed} percent elapsed, forecast exhausts the quota before reset (${window})`;
  }
  const lands = Math.round(geo.projYPct);
  const waste = Math.round(100 - geo.projYPct);
  if (waste > 0) {
    return `Burn-down: ${used} percent used at ${elapsed} percent elapsed, forecast lands at ${lands} percent with ${waste} percent waste (${window})`;
  }
  return `Burn-down: ${used} percent used at ${elapsed} percent elapsed, forecast lands at ${lands} percent (${window})`;
}

function fallbackBasis(provider: ProviderView, asOfMs: number): string {
  const advisory = provider.advisory;
  if (!advisory) return "No current reading";
  if (!isMonthlyBound(provider) && advisory.paceSource === "unknown") return "No current reading";
  const { avg, recent } = paceFigures(advisory);
  if (!isMonthlyBound(provider) && avg === null && recent !== null) return PACE_TIPS.recent;
  const startIso = quotaWindowStartIso(provider);
  const start = startIso ? Date.parse(startIso) : NaN;
  if (Number.isFinite(start) && Number.isFinite(asOfMs) && asOfMs > start) {
    const days = (asOfMs - start) / 86_400_000;
    if (days >= 0.1) return `averaged over ${days.toFixed(1)} days of this window`;
  }
  if (provider.evidence.includes("measured") || advisory.burnMeasured) return "Measured";
  if (advisory.paceSource === "window-average" || provider.evidence.includes("window-average")) {
    return "Window avg";
  }
  return PACE_TIPS.avg;
}

const PLOT = { left: 48, right: 388, top: 28, bottom: 142 } as const;
const PLOT_MID_X = (PLOT.left + PLOT.right) / 2;
const PLOT_MID_Y = (PLOT.top + PLOT.bottom) / 2;

function sx(pct: number): number {
  return PLOT.left + (pct / 100) * (PLOT.right - PLOT.left);
}
function sy(pct: number): number {
  return PLOT.bottom - (pct / 100) * (PLOT.bottom - PLOT.top);
}
function n(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/**
 * Pace section: burn-down SVG, the shared four-cell pace grid, and the
 * basis line. Returns null (omitting the whole section) when pace is
 * unknown, burnRate or elapsed is missing, or the provider is excluded.
 * The drawer may pass the basis line derived from paceBasis; standalone
 * use falls back to the same basis wording from period timestamps and
 * PACE_TIPS.
 */
export function BurnDown({
  provider,
  asOf,
  basis,
}: {
  provider: ProviderView;
  asOf: string;
  basis?: string;
}) {
  const asOfMs = Date.parse(asOf);
  const geo = burnGeometry(provider, asOfMs);
  if (!geo) return null;
  const basisLine = basis ?? fallbackBasis(provider, asOfMs);
  const tone = geo.tone;
  const nowX = sx(geo.elapsedPct);
  const nowY = sy(geo.usedPct);
  const projX = sx(geo.projXPct);
  const projY = sy(geo.projYPct);
  const showProjDot = Math.hypot(projX - nowX, projY - nowY) >= 3;
  const label = burnAriaLabel(provider, geo);
  const windowName = quotaWindowName(provider);
  const elapsedLabel = `${Math.round(geo.elapsedPct)}% elapsed`;
  // Center the now readout in the top callout band above PLOT.top, clamped to plot edges.
  const nowTextX = Math.min(PLOT.right - 46, Math.max(PLOT.left + 46, nowX));
  // Place "ideal pace" on whichever half of the diagonal is clear of the vertical now-line.
  const idealPct = geo.elapsedPct > 52 ? 35 : 66;
  const idealX = sx(idealPct);
  const idealY = sy(idealPct) - 5;
  return (
    <section className="dsec" aria-label="Pace" data-testid="burn-down-section">
      <div className="burn-head">
        <h3>Pace</h3>
        <span className="burn-win">{windowName} quota window</span>
      </div>
      <svg
        className="burn"
        viewBox="0 0 400 184"
        role="img"
        aria-label={label}
        data-testid="burn-down"
      >
        <text x={11} y={PLOT_MID_Y} className="axis-y" transform={`rotate(-90 11 ${PLOT_MID_Y})`}>
          Quota used (%)
        </text>
        <line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.bottom} className="grid" />
        <line x1={PLOT.left} y1={PLOT_MID_Y} x2={PLOT.right} y2={PLOT_MID_Y} className="grid" />
        <line x1={PLOT.left} y1={PLOT.top} x2={PLOT.right} y2={PLOT.top} className="grid" />
        <line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.left} y2={PLOT.bottom + 4} className="grid-tick" />
        <line x1={PLOT_MID_X} y1={PLOT.bottom} x2={PLOT_MID_X} y2={PLOT.bottom + 4} className="grid-tick" />
        <line x1={PLOT.right} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.bottom + 4} className="grid-tick" />
        <text x={40} y={PLOT.bottom + 3.5} className="ylab">0%</text>
        <text x={40} y={PLOT_MID_Y + 3.5} className="ylab">50%</text>
        <text x={40} y={PLOT.top + 3.5} className="ylab">100%</text>
        <line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.top} className="ideal" />
        <text
          x={n(idealX)}
          y={n(idealY)}
          className="ideal-lab"
          textAnchor="middle"
          transform={`rotate(-18.5 ${n(idealX)} ${n(idealY)})`}
        >
          ideal pace
        </text>
        <line x1={n(nowX)} y1={PLOT.top - 8} x2={n(nowX)} y2={PLOT.bottom} className="now" />
        <text x={n(nowTextX)} y={12} className="now-lab" textAnchor="middle">
          now · {elapsedLabel}
        </text>
        <line
          x1={PLOT.left}
          y1={PLOT.bottom}
          x2={n(nowX)}
          y2={n(nowY)}
          className={`actual ${tone}`}
          data-testid="burn-actual"
        />
        <line
          x1={n(nowX)}
          y1={n(nowY)}
          x2={n(projX)}
          y2={n(projY)}
          className={`proj ${tone}`}
          data-testid="burn-proj"
          data-proj-x={n(geo.projXPct)}
          data-proj-y={n(geo.projYPct)}
        />
        <circle cx={n(nowX)} cy={n(nowY)} r={4.5} className={`dot ${tone}`} />
        {showProjDot && (
          <circle cx={n(projX)} cy={n(projY)} r={3.5} className={`dot ${tone} hollow`} />
        )}
        <text x={PLOT.left} y={160} className="xlab">start · 0%</text>
        <text x={PLOT_MID_X} y={160} className="xlab mid">50%</text>
        <text x={PLOT.right} y={160} className="xlab end">quota reset · 100%</text>
        <text x={PLOT_MID_X} y={178} className="axis-x">Time elapsed in window (%)</text>
      </svg>
      <p className="burn-legend">
        <span className="legend-label">Legend</span>
        <span className="legend-item">
          <span className={`burn-swatch-dot ${tone}`} aria-hidden="true" />
          Dot is now
        </span>
        <span className="legend-item">
          <span className={`burn-swatch-proj ${tone}`} aria-hidden="true" />
          Dashed is forecast
        </span>
      </p>
      <PaceStats provider={provider} asOf={asOf} />
      <p className="pacecap">
        <span className="basis">{basisLine}</span>
      </p>
    </section>
  );
}
