import React from "react";
import type { ProviderView } from "../state.js";
import { resetDateClock, resetDay } from "./PaceBar.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** One-unit countdown for a window tag: "7d", "4h" or "40m". Null when passed or unparseable. */
export function windowCountdown(resetsAt: string, asOfMs: number): string | null {
  const diff = Date.parse(resetsAt) - asOfMs;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  if (diff >= DAY_MS) return `${Math.floor(diff / DAY_MS)}d`;
  if (diff >= HOUR_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(diff / MIN_MS))}m`;
}

export interface WindowUnit {
  win: "five" | "month";
  tag: "5h" | "Mth";
  cardLabel: string;
  rowLabel: string;
  pct: number;
  /** Presentation-only heat: < 80 none, 80–99 hot, 100 or exhausted full. */
  heat: "" | "hot" | "full";
  /** Tag time outside the pill: "in 7d", or the weekday plus date when the month is exhausted. */
  time: string | null;
  /** Expanded card track's reset line. */
  reset: string | null;
}

function heatOf(pct: number, exhausted: boolean): WindowUnit["heat"] {
  if (exhausted || pct >= 100) return "full";
  return pct >= 80 ? "hot" : "";
}

/** Present windows only; a unit with no data is not rendered at all. */
export function windowUnits(provider: ProviderView, asOfMs: number): WindowUnit[] {
  const q = provider.quota;
  if (!q) return [];
  const units: WindowUnit[] = [];
  if (typeof q.fiveHourPct === "number" && Number.isFinite(q.fiveHourPct)) {
    // No adapter reports a 5h reset, so the 5h tag carries no time.
    units.push({ win: "five", tag: "5h", cardLabel: "5h limit", rowLabel: "5h",
      pct: q.fiveHourPct, heat: heatOf(q.fiveHourPct, false), time: null, reset: null });
  }
  if (q.monthlyKind === "included" && typeof q.monthlyPct === "number" && q.monthlyResetsAt) {
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

function trackFill(u: WindowUnit): React.CSSProperties {
  const cap = u.pct >= 80 || u.heat === "full";
  return {
    width: `${Math.min(100, Math.max(0, u.pct))}%`,
    background: cap ? "var(--fill-cap)" : "var(--fill-ontrack)",
    ["--fill-edge" as string]: cap ? "var(--edge-cap)" : "var(--edge-ontrack)",
  };
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
