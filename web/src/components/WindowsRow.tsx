import React from "react";
import type { ProviderView } from "../state.js";
import { resetDateClock, resetDay, timeLeft } from "./PaceBar.js";

/** Window tag countdown in the shared form, e.g. "1d 20h". Null when passed or unparseable. */
export function windowCountdown(resetsAt: string, asOfMs: number): string | null {
  return timeLeft(resetsAt, asOfMs);
}

export interface WindowUnit {
  win: "five" | "month" | "week";
  tag: "5h" | "Mth" | "Wk";
  cardLabel: string;
  rowLabel: string;
  pct: number;
  /** Presentation-only heat: < 80 none, 80–99 hot, 100 or exhausted full. */
  heat: "" | "hot" | "full";
  /** Tag time outside the pill: "in 1d 20h", or the weekday plus date when the month is exhausted. */
  time: string | null;
  /** Expanded card track's reset line. */
  reset: string | null;
}

function heatOf(pct: number, exhausted: boolean): WindowUnit["heat"] {
  if (exhausted || pct >= 100) return "full";
  return pct >= 80 ? "hot" : "";
}

/**
 * Secondary (rate-limit) windows only. The quota window already owns the
 * main bar, so it never repeats here: weekly-bound providers show 5h and
 * monthly; monthly-bound providers show weekly and 5h, with the weekly
 * reset kept as rate-limit detail.
 */
export function windowUnits(provider: ProviderView, asOfMs: number): WindowUnit[] {
  const q = provider.quota;
  if (!q) return [];
  const monthlyBound =
    provider.advisory?.bindingWindow === "monthly" &&
    q.monthlyKind === "included" &&
    typeof q.monthlyPct === "number" &&
    !!q.monthlyResetsAt;
  const units: WindowUnit[] = [];
  if (monthlyBound && typeof q.weeklyPct === "number" && Number.isFinite(q.weeklyPct)) {
    const left = windowCountdown(q.resetsAt, asOfMs);
    units.push({ win: "week", tag: "Wk", cardLabel: "Weekly", rowLabel: "Week",
      pct: q.weeklyPct, heat: heatOf(q.weeklyPct, false),
      time: left ? `in ${left}` : null,
      reset: left ? `in ${left}` : null });
  }
  if (typeof q.fiveHourPct === "number" && Number.isFinite(q.fiveHourPct)) {
    const passed = q.fiveHourResetsAt ? Date.parse(q.fiveHourResetsAt) <= asOfMs : false;
    const effectivePct = passed ? 0 : q.fiveHourPct;
    units.push({ win: "five", tag: "5h", cardLabel: "5h limit", rowLabel: "5h",
      pct: effectivePct, heat: heatOf(effectivePct, false), time: null, reset: null });
  }
  if (!monthlyBound && q.monthlyKind === "included" && typeof q.monthlyPct === "number" && q.monthlyResetsAt) {
    const exhausted = q.monthlyStatus === "exhausted";
    const left = windowCountdown(q.monthlyResetsAt, asOfMs);
    const clock = resetDateClock(q.monthlyResetsAt);
    units.push({ win: "month", tag: "Mth", cardLabel: "Monthly", rowLabel: "Month",
      pct: q.monthlyPct, heat: heatOf(q.monthlyPct, exhausted),
      time: exhausted ? resetDay(q.monthlyResetsAt) : left ? `in ${left}` : null,
      reset: exhausted ? (clock ? `resets ${clock}` : null) : left ? `in ${left}` : null });
  }
  return units;
}

/** Shared severity fill: cap colour at >= 80 (or exhausted/full), ontrack below. */
export function trackFillForPct(pct: number, exhausted = false): React.CSSProperties {
  const cap = exhausted || pct >= 80;
  return {
    width: `${Math.min(100, Math.max(0, pct))}%`,
    background: cap ? "var(--fill-cap)" : "var(--fill-ontrack)",
    ["--fill-edge" as string]: cap ? "var(--edge-cap)" : "var(--edge-ontrack)",
  };
}

export const severityFill = trackFillForPct;
export const windowTrackFill = trackFillForPct;

export function trackFill(u: WindowUnit): React.CSSProperties {
  return trackFillForPct(u.pct, u.heat === "full");
}

/**
 * Collapsed windows line under the weekly bar, with a per-card chevron that
 * expands thin tracks. A real button inside the card's role="button": click
 * stops propagation so it never opens the drawer, and the card's own keydown
 * ignores keys aimed at this button.
 */
export function WindowsRow({ provider, asOf, variant }: { provider: ProviderView; asOf: string; variant: "card" | "row" }) {
  const [open, setOpen] = React.useState(false);
  const units = windowUnits(provider, Date.parse(asOf));
  if (units.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="wline"
        data-testid={`wline-${provider.id}`}
        aria-expanded={open}
        aria-label={`${provider.displayName} other windows: ${units.map((u) => `${u.tag} ${u.pct}%${u.time ? ` ${u.time}` : ""}`).join(", ")}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {units.map((u) => (
          <span key={u.win} className="unit" data-win={u.win}>
            <span className={u.heat ? `seg ${u.heat}` : "seg"}>
              <span className="k">{u.tag}</span>
              <span className="n">{u.pct}%</span>
            </span>
            {u.time && <span className="t">{u.time}</span>}
          </span>
        ))}
        <span className="chev" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="windows" data-testid={`windows-${provider.id}`}>
          {units.map((u) => (
            <div key={u.win} className="win" data-win={u.win}>
              <span className="lab">{variant === "card" ? u.cardLabel : u.rowLabel}</span>
              <div className="track">
                <div className="fill" style={trackFill(u)} />
              </div>
              <span className="pct">{u.pct}%</span>
              {variant === "card" && u.reset && <span className="reset">{u.reset}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
